const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 5 * 60 * 1000;
const rooms = {}; // roomCode -> { hostId, players: [{id,name}], gameStarted, questions, currentQuestion, scores, answers, timerId, lastActive }

app.use(express.static(path.join(__dirname)));

function createRoomState(hostId) {
    return {
        hostId,
        players: [],
        gameStarted: false,
        questions: [],
        currentQuestion: 0,
        scores: {},
        answers: {},
        timeLimit: 15,
        lastActive: Date.now(),
        cleanupTimer: null
    };
}

function resetRoomTTL(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.lastActive = Date.now();
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);

    room.cleanupTimer = setTimeout(() => {
        console.log(`Cleaning up inactive room ${roomCode}`);
        if (rooms[roomCode]) {
            io.to(roomCode).emit('roomClosed', 'Room closed due to inactivity');
            delete rooms[roomCode];
        }
    }, ROOM_TTL_MS);
}

io.on('connection', (socket) => {
    console.log('socket connected', socket.id);

    socket.on('joinRoom', ({ roomCode, playerName, asHost }) => {
        if (!roomCode || !playerName) {
            socket.emit('roomJoinFailed', 'Invalid room or name');
            return;
        }

        roomCode = roomCode.toUpperCase();

        if (!rooms[roomCode]) {
            if (!asHost) {
                socket.emit('roomJoinFailed', 'Room does not exist. Create room first.');
                return;
            }
            rooms[roomCode] = createRoomState(socket.id);
        }

        const room = rooms[roomCode];

        const existing = room.players.find((p) => p.name === playerName);
        if (existing && existing.id !== socket.id) {
            socket.emit('roomJoinFailed', 'Name already in use in this room');
            return;
        }

        if (!room.players.find((p) => p.id === socket.id)) {
            room.players.push({ id: socket.id, name: playerName });
        }

        room.hostId = room.hostId || socket.id;
        room.lastActive = Date.now();

        socket.join(roomCode);

        console.log(`Player ${playerName} joined room ${roomCode}`);

        io.to(roomCode).emit('roomUpdate', {
            roomCode,
            players: room.players,
            hostId: room.hostId,
            gameStarted: room.gameStarted,
            currentQuestion: room.currentQuestion,
            questions: room.questions.map((q) => ({ q: q.q, o: q.o })),
            scores: room.scores
        });

        if (room.gameStarted) {
            socket.emit('syncGameState', {
                questions: room.questions,
                currentQuestion: room.currentQuestion,
                scores: room.scores,
                gameStarted: true
            });
        }

        resetRoomTTL(roomCode);
    });

    socket.on('startGame', ({ roomCode, difficulty, timeLimit }) => {
        if (!roomCode || !rooms[roomCode]) return;
        const room = rooms[roomCode];
        if (socket.id !== room.hostId) return;

        room.gameStarted = true;
        room.currentQuestion = 0;
        const bank = questionBanks[difficulty] || questionBanks.easy;
        room.questions = shuffle([...bank]).slice(0, 10).map(q => ({
            ...q,
            o: shuffle([...q.o])
        }));
        room.scores = {};
        room.answers = {};
        room.timeLimit = timeLimit || 15;

        room.players.forEach((p) => (room.scores[p.name] = 0));

        io.to(roomCode).emit('syncGameState', {
            questions: room.questions,
            currentQuestion: room.currentQuestion,
            scores: room.scores,
            gameStarted: true,
            timeLimit: room.timeLimit
        });

        resetRoomTTL(roomCode);
    });

    socket.on('kickPlayer', ({ roomCode, targetName }) => {
        if (!roomCode || !rooms[roomCode] || !targetName) return;
        const room = rooms[roomCode];
        if (socket.id !== room.hostId) return;

        const player = room.players.find((p) => p.name === targetName);
        if (!player) return;

        room.players = room.players.filter((p) => p.name !== targetName);
        io.to(roomCode).emit('roomUpdate', {
            roomCode,
            players: room.players,
            hostId: room.hostId,
            gameStarted: room.gameStarted,
            currentQuestion: room.currentQuestion,
            questions: room.questions.map((q) => ({ q: q.q, o: q.o })),
            scores: room.scores
        });

        io.to(player.id).emit('kicked', 'You have been kicked from the room by the host');
        io.sockets.sockets.get(player.id)?.leave(roomCode);

        resetRoomTTL(roomCode);
    });

    socket.on('submitAnswer', ({ roomCode, playerName, selected }) => {
        if (!roomCode || !rooms[roomCode] || !playerName) return;
        const room = rooms[roomCode];
        if (!room.gameStarted) return;

        const q = room.questions[room.currentQuestion];
        if (!q || room.answers[room.currentQuestion]?.includes(playerName)) return;

        room.answers[room.currentQuestion] = room.answers[room.currentQuestion] || [];
        room.answers[room.currentQuestion].push(playerName);

        if (selected === q.a) {
            room.scores[playerName] = (room.scores[playerName] || 0) + 1000;
        }

        io.to(roomCode).emit('syncAnswers', {
            playerName,
            selected,
            correct: selected === q.a,
            scores: room.scores
        });

        const answeredCount = room.answers[room.currentQuestion].length;
        const totalPlayers = room.players.length;
        if (answeredCount >= totalPlayers) {
            room.currentQuestion += 1;
            if (room.currentQuestion >= room.questions.length) {
                io.to(roomCode).emit('gameOver', { scores: room.scores });
                room.gameStarted = false;
            } else {
                io.to(roomCode).emit('advanceQuestion', {
                    currentQuestion: room.currentQuestion,
                    scores: room.scores
                });
            }
        }

        resetRoomTTL(roomCode);
    });

    socket.on('disconnect', () => {
        for (const [code, room] of Object.entries(rooms)) {
            const index = room.players.findIndex((p) => p.id === socket.id);
            if (index !== -1) {
                const disconnectedPlayer = room.players.splice(index, 1)[0];
                console.log(`Player ${disconnectedPlayer.name} left room ${code}`);

                if (room.hostId === socket.id) {
                    if (room.players.length > 0) {
                        room.hostId = room.players[0].id;
                    } else {
                        if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
                        delete rooms[code];
                        continue;
                    }
                }

                io.to(code).emit('roomUpdate', {
                    roomCode: code,
                    players: room.players,
                    hostId: room.hostId,
                    gameStarted: room.gameStarted,
                    currentQuestion: room.currentQuestion,
                    questions: room.questions.map((q) => ({ q: q.q, o: q.o })),
                    scores: room.scores
                });

                resetRoomTTL(code);
            }
        }
    });
});

const questionBanks = {
    easy: [
        { q: '2 + 3 = ?', a: '5', o: ['4', '5', '6', '7'] },
        { q: '1 + 4 = ?', a: '5', o: ['4', '5', '6', '3'] },
        { q: '5 + 2 = ?', a: '7', o: ['6', '7', '8', '5'] },
        { q: '2 × 3 = ?', a: '6', o: ['5', '6', '7', '8'] },
        { q: 'What does happy mean?', a: 'Joyful', o: ['Sad', 'Joyful', 'Angry', 'Tired'] },
        { q: 'What do plants need to grow?', a: 'Sunlight', o: ['Darkness', 'Sunlight', 'Ice', 'Wind'] },
        { q: '3 + 1 = ?', a: '4', o: ['3', '4', '5', '6'] },
        { q: '4 - 2 = ?', a: '2', o: ['1', '2', '3', '4'] },
        { q: 'What color is the sky?', a: 'Blue', o: ['Red', 'Blue', 'Green', 'Yellow'] },
        { q: 'How many legs does a cat have?', a: '4', o: ['2', '4', '6', '8'] }
    ],
    intermediate: [
        { q: '7 + 8 = ?', a: '15', o: ['14', '15', '16', '17'] },
        { q: '12 - 5 = ?', a: '7', o: ['6', '7', '8', '9'] },
        { q: '3 × 4 = ?', a: '12', o: ['9', '10', '11', '12'] },
        { q: '18 ÷ 3 = ?', a: '6', o: ['4', '5', '6', '7'] },
        { q: 'What is a synonym for fast?', a: 'Quick', o: ['Slow', 'Quick', 'Big', 'Small'] },
        { q: 'What is the opposite of hot?', a: 'Cold', o: ['Warm', 'Cold', 'Wet', 'Dry'] },
        { q: '9 + 6 = ?', a: '15', o: ['13', '14', '15', '16'] },
        { q: '20 - 7 = ?', a: '13', o: ['12', '13', '14', '15'] },
        { q: 'What does "brave" mean?', a: 'Courageous', o: ['Scared', 'Courageous', 'Lazy', 'Smart'] },
        { q: 'What is 5 squared?', a: '25', o: ['20', '25', '30', '35'] }
    ],
    hard: [
        { q: '15 + 27 = ?', a: '42', o: ['40', '41', '42', '43'] },
        { q: '48 ÷ 6 = ?', a: '8', o: ['6', '7', '8', '9'] },
        { q: '7 × 9 = ?', a: '63', o: ['60', '61', '63', '65'] },
        { q: 'What is the capital of France?', a: 'Paris', o: ['London', 'Paris', 'Berlin', 'Rome'] },
        { q: 'What is a synonym for intelligent?', a: 'Smart', o: ['Dumb', 'Smart', 'Fast', 'Slow'] },
        { q: 'What is 10 cubed?', a: '1000', o: ['100', '500', '1000', '1500'] },
        { q: '23 + 19 = ?', a: '42', o: ['41', '42', '43', '44'] },
        { q: '64 ÷ 8 = ?', a: '8', o: ['7', '8', '9', '10'] },
        { q: 'What does "ephemeral" mean?', a: 'Short-lived', o: ['Eternal', 'Short-lived', 'Bright', 'Dark'] },
        { q: 'What is the square root of 144?', a: '12', o: ['10', '11', '12', '13'] }
    ],
    exceptional: [
        { q: '37 + 58 = ?', a: '95', o: ['93', '94', '95', '96'] },
        { q: '144 ÷ 12 = ?', a: '12', o: ['10', '11', '12', '13'] },
        { q: '13 × 17 = ?', a: '221', o: ['210', '215', '221', '225'] },
        { q: 'What is the capital of Australia?', a: 'Canberra', o: ['Sydney', 'Melbourne', 'Canberra', 'Perth'] },
        { q: 'What does "ubiquitous" mean?', a: 'Everywhere', o: ['Nowhere', 'Everywhere', 'Rare', 'Common'] },
        { q: 'What is 15 to the power of 2?', a: '225', o: ['200', '215', '225', '235'] },
        { q: '89 - 34 = ?', a: '55', o: ['53', '54', '55', '56'] },
        { q: '196 ÷ 14 = ?', a: '14', o: ['12', '13', '14', '15'] },
        { q: 'What is a synonym for "perspicacious"?', a: 'Shrewd', o: ['Dull', 'Shrewd', 'Slow', 'Fast'] },
        { q: 'What is the cube root of 1000?', a: '10', o: ['8', '9', '10', '11'] }
    ]
};

function shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT} (accessible from other devices)`);
});