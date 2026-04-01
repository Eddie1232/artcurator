// Game State
let currentQuestion = 0;
let gameActive = false;
let players = [];
let currentQuestions = [];
let scores = {};
let currentTimeLimit = 15;
let timerId = null;

// Last game settings
let lastDifficulty = 'easy';
let lastTimeLimit = 15;
let lastNumPlayers = 1;
let lastPlayerNames = ['Player 1'];

// Network state
let socket = null;
let currentRoom = null;
let myName = null;
let isHost = false;

const elements = {
    networkPanel: document.getElementById('networkPanel'),
    lobbyStatus: document.getElementById('lobbyStatus'),
    roomPlayers: document.getElementById('playersList'),
    setupPanel: document.getElementById('setupPanel'),
    waitingPanel: document.getElementById('waitingPanel'),
    waitingPlayersList: document.getElementById('waitingPlayersList'),
    gamePanel: document.getElementById('gamePanel'),
    resultsPanel: document.getElementById('resultsPanel'),
    questionNumber: document.getElementById('questionNumber'),
    questionText: document.getElementById('questionText'),
    timer: document.getElementById('timer'),
    options: document.getElementById('options'),
    finalScores: document.getElementById('finalScores')
};

function setLobbyStatus(text, color = '#333') {
    elements.lobbyStatus.textContent = text;
    elements.lobbyStatus.style.color = color;
}

function persistSession() {
    if (currentRoom && myName) {
        localStorage.setItem('artcuratorRoom', currentRoom);
        localStorage.setItem('artcuratorName', myName);
    }
}

function clearSession() {
    localStorage.removeItem('artcuratorRoom');
    localStorage.removeItem('artcuratorName');
}

function resetToLobby() {
    gameActive = false;
    currentQuestion = 0;
    currentQuestions = [];
    scores = {};
    players = [];
    currentRoom = null;
    isHost = false;
    myName = null;
    clearSession();

    elements.networkPanel.style.display = 'block';
    elements.setupPanel.style.display = 'none';
    elements.waitingPanel.style.display = 'none';
    elements.gamePanel.style.display = 'none';
    elements.resultsPanel.style.display = 'none';
    setLobbyStatus('Lobby cleared. Connect or create a new room.');
}

function applySyncState(state) {
    currentQuestions = state.questions || [];
    currentQuestion = state.currentQuestion || 0;
    scores = state.scores || {};
    currentTimeLimit = state.timeLimit || 15;
    gameActive = !!state.gameStarted;

    renderPlayerCards();
    if (gameActive) {
        elements.setupPanel.style.display = 'none';
        elements.waitingPanel.style.display = 'none';
        elements.gamePanel.style.display = 'block';
        elements.resultsPanel.style.display = 'none';
        showQuestion();
    }
}

function connectSocket() {
    if (!window.io) {
        setLobbyStatus('Socket.io client not loaded.', 'red');
        return;
    }

    socket = io();

    socket.on('connect', () => {
        setLobbyStatus('Connected to server');
        const cachedRoom = localStorage.getItem('artcuratorRoom');
        const cachedName = localStorage.getItem('artcuratorName');
        if (cachedRoom && cachedName) {
            document.getElementById('roomCodeInput').value = cachedRoom;
            document.getElementById('playerNameInput').value = cachedName;
            joinRoom(cachedRoom, false);
        }
    });

    socket.on('disconnect', () => {
        setLobbyStatus('Disconnected from server', 'red');
    });

    socket.on('roomUpdate', (payload) => {
        currentRoom = payload.roomCode;
        players = payload.players.map((p) => p.name);
        isHost = socket.id === payload.hostId;
        scores = payload.scores || {};
        gameActive = payload.gameStarted || false;

        renderPlayerCards();

        const joinedText = `${players.length} player(s) in room ${currentRoom}`;
        const hostText = isHost ? ' (Host)' : '';
        setLobbyStatus(`${joinedText}${hostText}`);

        // Show appropriate panel
        elements.networkPanel.style.display = 'none';
        if (isHost) {
            elements.setupPanel.style.display = 'block';
            elements.waitingPanel.style.display = 'none';
        } else {
            elements.setupPanel.style.display = 'none';
            elements.waitingPanel.style.display = 'block';
            renderWaitingPlayers();
        }

        if (payload.gameStarted) {
            applySyncState(payload);
        }

        persistSession();
    });

    socket.on('roomJoinFailed', (message) => {
        setLobbyStatus(message, 'red');
    });

    socket.on('syncGameState', (state) => {
        applySyncState(state);
    });

    socket.on('syncAnswers', ({ playerName, selected, correct, scores: serverScores }) => {
        scores = serverScores;
        renderPlayerCards();
        setLobbyStatus(`${playerName} answered ${selected} — ${correct ? 'correct' : 'wrong'}`);
    });

    socket.on('advanceQuestion', ({ currentQuestion: next, scores: serverScores }) => {
        currentQuestion = next;
        scores = serverScores;
        renderPlayerCards();
        showQuestion();
    });

    socket.on('gameOver', ({ scores: finalScores }) => {
        scores = finalScores;
        showResults();
        gameActive = false;
    });

    socket.on('kicked', (message) => {
        alert(message);
        resetToLobby();
    });

    socket.on('roomClosed', (message) => {
        alert(message);
        resetToLobby();
    });
}

function createRoom() {
    const roomCode = document.getElementById('roomCodeInput').value.trim();
    const playerName = document.getElementById('playerNameInput').value.trim();

    if (!playerName) {
        setLobbyStatus('Enter your name first', 'red');
        return;
    }

    const code = roomCode || Math.random().toString(36).substring(2, 8).toUpperCase();
    document.getElementById('roomCodeInput').value = code;

    myName = playerName;
    currentRoom = code;
    joinRoom(code, true);
}

function joinRoom(existingCode, asHost = false) {
    const roomCode = existingCode || document.getElementById('roomCodeInput').value.trim();
    const playerName = myName || document.getElementById('playerNameInput').value.trim();

    if (!roomCode || !playerName) {
        setLobbyStatus('Give room code and name', 'red');
        return;
    }

    myName = playerName;
    currentRoom = roomCode.toUpperCase();

    if (!socket) connectSocket();

    socket.emit('joinRoom', { roomCode: currentRoom, playerName: myName, asHost });
}

function requestStartGame() {
    if (!currentRoom || !socket) {
        setLobbyStatus('Join a room first', 'red');
        return;
    }
    if (!isHost) {
        setLobbyStatus('Only host can start the game', 'red');
        return;
    }

    const difficulty = document.getElementById('difficulty').value;
    const timeLimit = parseInt(document.getElementById('timeLimit').value);
    const numPlayers = parseInt(document.getElementById('numPlayers').value);
    const playerNames = [];
    document.querySelectorAll('#playerInputs input').forEach(input => {
        if (input.value.trim()) playerNames.push(input.value.trim());
    });

    // Store settings for restart
    lastDifficulty = difficulty;
    lastTimeLimit = timeLimit;
    lastNumPlayers = numPlayers;
    lastPlayerNames = playerNames;

    socket.emit('startGame', { 
        roomCode: currentRoom,
        difficulty,
        timeLimit,
        numPlayers,
        playerNames
    });
}

function kickPlayer(name) {
    if (!currentRoom || !socket || !isHost) return;
    if (name === myName) return;
    socket.emit('kickPlayer', { roomCode: currentRoom, targetName: name });
}

function restartGame() {
    if (!currentRoom || !socket) {
        setLobbyStatus('Join a room first', 'red');
        return;
    }
    if (!isHost) {
        setLobbyStatus('Only host can restart the game', 'red');
        return;
    }

    socket.emit('startGame', { 
        roomCode: currentRoom,
        difficulty: lastDifficulty,
        timeLimit: lastTimeLimit,
        numPlayers: lastNumPlayers,
        playerNames: lastPlayerNames
    });
}

function renderPlayerCards() {
    if (!elements.roomPlayers) return;
    elements.roomPlayers.innerHTML = '';
    players.forEach((name) => {
        const card = document.createElement('div');
        card.className = 'player-card';
        card.innerHTML = `<div class="player-name">${name}</div><div class="player-score">Score: ${scores[name] || 0}</div>`;

        if (isHost && name !== myName) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'remove-player';
            kickBtn.textContent = 'Kick';
            kickBtn.onclick = () => kickPlayer(name);
            card.appendChild(kickBtn);
        }

        if (isHost && name === myName) {
            const hostLabel = document.createElement('div');
            hostLabel.style.fontSize = '0.9em';
            hostLabel.style.marginTop = '4px';
            hostLabel.textContent = 'Host';
            card.appendChild(hostLabel);
        }

        elements.roomPlayers.appendChild(card);
    });
}

function renderWaitingPlayers() {
    if (!elements.waitingPlayersList) return;
    elements.waitingPlayersList.innerHTML = '';
    players.forEach((name) => {
        const card = document.createElement('div');
        card.className = 'player-card';
        card.innerHTML = `<div class="player-name">${name}</div>`;
        if (name === myName) {
            card.innerHTML += '<div style="font-size: 0.9em; margin-top: 4px;">(You)</div>';
        }
        elements.waitingPlayersList.appendChild(card);
    });
}

function showQuestion() {
    if (!gameActive || currentQuestion >= currentQuestions.length) {
        showResults();
        return;
    }

    const question = currentQuestions[currentQuestion];
    if (!question) {
        showResults();
        return;
    }

    elements.questionNumber.textContent = `Question ${currentQuestion + 1} / ${currentQuestions.length}`;
    elements.questionText.textContent = question.q;

    elements.options.innerHTML = '';
    question.o.forEach((option) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.textContent = option;
        btn.onclick = () => submitAnswer(option);
        elements.options.appendChild(btn);
    });

    // Start countdown timer
    if (timerId) clearInterval(timerId);
    let timeLeft = currentTimeLimit;
    elements.timer.textContent = timeLeft;
    elements.timer.style.color = timeLeft <= 5 ? 'red' : 'blue';
    timerId = setInterval(() => {
        timeLeft--;
        elements.timer.textContent = timeLeft;
        elements.timer.style.color = timeLeft <= 5 ? 'red' : 'blue';
        if (timeLeft <= 0) {
            clearInterval(timerId);
            timerId = null;
            // Auto-submit empty answer on timeout
            submitAnswer('');
        }
    }, 1000);
}

function submitAnswer(answer) {
    if (!socket || !currentRoom || !myName) return;

    socket.emit('submitAnswer', {
        roomCode: currentRoom,
        playerName: myName,
        selected: answer
    });
}

function showResults() {
    if (timerId) {
        clearInterval(timerId);
        timerId = null;
    }
    gameActive = false;
    elements.gamePanel.style.display = 'none';
    elements.resultsPanel.style.display = 'block';

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    elements.finalScores.innerHTML = sorted
        .map((entry, idx) => `<p class="rank">${idx + 1}. ${entry[0]}: ${entry[1]}</p>`)
        .join('');
}

window.addEventListener('load', () => {
    connectSocket();
    setLobbyStatus('Ready. Create or join a room.');
});
