window.DEBUG = {
    enabled: null,
    isLocal: () => (window.location.port || '80') === '777',
    log: function(...args) {
        if (this.enabled === null) {
            if (this.isLocal()) {
                console.log(...args);
            }
        } else if (this.enabled) {
            console.log(...args);
        }
    },
    enable: function() {
        this.enabled = true;
        console.log('Debug mode explicitly enabled');
    },
    deactivate: function() {
        this.enabled = false;
        console.log('Debug mode explicitly deactivated');
    },
    reset: function() {
        this.enabled = null;
        console.log('Debug mode reset to default behavior');
    },
    on: function() { this.enable(); },
    off: function() { this.deactivate(); }
};

let game;
let gameInProgress = false;

let currentSlide = 0;

class GameAdmin {
    static showError(message) {
        const overlay = document.getElementById('error-overlay');
        const errorMessage = document.getElementById('error-message');
        errorMessage.textContent = message;
        overlay.classList.remove('hidden');
    }

    showMessage(message, duration = 3000) {
        const messageOverlay = document.getElementById('messageOverlay');
        const messageText = messageOverlay.querySelector('.message-text');

        if (!messageOverlay || !messageText) return;

        messageText.textContent = message;

        messageOverlay.classList.remove('hidden');
        messageOverlay.classList.add('visible');

        setTimeout(() => {
            messageOverlay.classList.remove('visible');
            setTimeout(() => {
                messageOverlay.classList.add('hidden');
            }, 300); 
        }, duration);
    }

    constructor() {
        this.ws = null;
        this.gameCode = null;
        this.apiCode = null;
        this.players = new Map();
        this.teams = [];
        this.teamMode = 'allVsAll';
        this.answerTime = parseInt(localStorage.getItem('truths_and_lies_answer_time')) || 30;
        this.roundsCount = parseInt(localStorage.getItem('truths_and_lies_rounds_count')) || 3;
        this.waitTime = parseInt(localStorage.getItem('truths_and_lies_wait_time')) || 30;
        this.currentRound = 0;

        this.alwaysShowWaitTimePopup = true;
        this.timerInterval = null;
        this.countdownInterval = null;
        this.countdownSeconds = 5;
        this.statements = [];
        this.readyPlayers = new Set();
        this.gamePhase = 'setup';
        this.gameStarted = false;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 9999999999;

        this.adminName = localStorage.getItem('truths_and_lies_admin_name') || '';

        this.initializePlayersList();
        this.initializeAdminNameModal();
        this.initializeGameOptions();
        this.initializeEventListeners();

        DEBUG.log('Truths and Lies Game Admin initialized');
        this.connectToServer();
        this.updateStartButton();

        const winnerScreen = document.querySelector('.winner-screen');
        if (winnerScreen) {
            const winnerColorDiv = winnerScreen.querySelector('.winner-color');
            const winnerImage = winnerScreen.querySelector('.winner-image');

            if (winnerColorDiv && winnerImage) {
                this.winnerColorDiv = winnerColorDiv;
                this.winnerImage = winnerImage;

                window.addEventListener('resize', () => this.updateWinnerFontSize());

                this.updateWinnerFontSize();
            }
        }


        const copyButton = document.getElementById('copyButton');
        if (copyButton) {
            copyButton.addEventListener('click', () => {
                const copyLinkInput = document.getElementById('copyLinkInput');
                const currentUrl = window.location.href;
                const baseUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/'));
                const gameLink = `${baseUrl}/player.html?code=${this.gameCode}`;

                copyLinkInput.value = gameLink;
                copyLinkInput.select();
                document.execCommand('copy');

                const buttonSpan = copyButton.querySelector('span');
                buttonSpan.textContent = 'Copied!';
                setTimeout(() => {
                    buttonSpan.textContent = 'Copy Game Link';
                }, 2000);
            });
        }

        const startButton = document.getElementById('start-button');
        const startTimerButton = document.getElementById('start-timer-button');

        if (startButton) {
            startButton.addEventListener('click', () => this.startGame());
        }

        const playAgainBtn = document.querySelector('.play-again-btn');
        if (playAgainBtn) {
            playAgainBtn.addEventListener('click', () => {
                this.handlePlayAgain();
            });
        }

        const resetGameBtn = document.getElementById('reset-game-button');
        if (resetGameBtn) {
            resetGameBtn.addEventListener('click', () => {
                if (confirm('Are you sure you want to reset the game? This will clear all player statements and guesses.')) {
                    this.resetGame();
                }
            });
        }

        const finishGameBtn = document.getElementById('finish-game-button');
        if (finishGameBtn) {
            finishGameBtn.addEventListener('click', () => {
                if (confirm('Are you sure you want to end the game now? This will skip any remaining rounds and show final results.')) {
                    if (this.ws && this.isConnected) {
                        this.ws.send(JSON.stringify({
                            type: 'finish_game'
                        }));
                    }
                }
            });
        }

        const backToDashboardBtn = document.getElementById('back-to-dashboard-btn');
        if (backToDashboardBtn) {
            backToDashboardBtn.addEventListener('click', () => {
                this.resetGame();
            });
        }

        document.addEventListener('keydown', (e) => {
            const isInputElement = e.target.tagName === 'INPUT' ||
                                  e.target.tagName === 'TEXTAREA' ||
                                  e.target.isContentEditable;

            if (e.code === 'Space' && this.gamePhase === 'guessing' && !isInputElement) {
                e.preventDefault();
            }
        });

        const zoomIn = document.getElementById('zoomIn');
        const zoomOut = document.getElementById('zoomOut');

        if (zoomIn) zoomIn.addEventListener('click', () => this.handleZoom(0.1));
        if (zoomOut) zoomOut.addEventListener('click', () => this.handleZoom(-0.1));
    }

    connectToServer() {
        const port = window.location.port || '80';
        const isLocalDevelopment = port === '777';
        const protocol = isLocalDevelopment ? "ws:" : "wss:";
        const host = isLocalDevelopment ? "127.0.0.1" : port === '3082' ? 'deploy.ylo.one' : 'gs.team-play.online/one-lie-two-truths-server';
        const wsPort = isLocalDevelopment ? '8083' : port === '3082' ? '3092' : undefined;

        const wsUrl = wsPort ? `${protocol}//${host}:${wsPort}` : `${protocol}//${host}`;
        DEBUG.log('Connecting to server at:', wsUrl);

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            DEBUG.log('Connected to server');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.updateConnectionStatus('Connected', true);

            const gameCode = localStorage.getItem('truth_and_lies_admin_game_code') || null;

            this.ws.send(JSON.stringify({
                type: 'create_session',
                gameCode: gameCode,
                apiCode: this.apiCode
            }));

            if (this.shouldSendAdminName && this.adminName) {
                DEBUG.log('Sending admin name after connection established:', this.adminName);
                this.ws.send(JSON.stringify({
                    type: 'admin_name_update',
                    name: this.adminName
                }));
                this.shouldSendAdminName = false;
            }

            DEBUG.log('Sending game settings after connection established');
            this.ws.send(JSON.stringify({
                type: 'update_game_settings',
                answerTime: this.answerTime,
                roundsCount: this.roundsCount
            }));

            const hasPlayers = this.players.size > 0;
            const startButton = document.getElementById('start-button');
            if (startButton) {
                if (hasPlayers) {
                    startButton.classList.remove('turned-off');
                } else {
                    startButton.classList.add('turned-off');
                }
            }
        };

        this.ws.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);

                switch(data.type) {
                    case 'show_message':
                        DEBUG.log('Received show_message event:', data);
                        this.showMessage(data.message, data.duration || 3000);
                        break;

                    case 'example_statements':
                        this.updateCarouselWithExamples(data.examples);
                        break;

                    case 'error':
                        if (data.code === 'SERVER_RESTART') {
                            this.updateConnectionStatus(data.message, false);
                            setTimeout(() => {
                                window.location.reload();
                            }, 2000);
                        } else if (data.code === 'API_ERROR') {
                            this.updateConnectionStatus(data.message, false);
                            GameAdmin.showError(data.message);
                        } else if (data.code === 'ADMIN_EXISTS') {
                            GameAdmin.showError(data.message);
                            if (this.ws) {
                                this.ws.close();
                                this.ws = null;
                            }
                        }
                        break;

                    case 'session_created':
                        this.gameCode = data.sessionId;
                        localStorage.setItem('truth_and_lies_admin_game_code', this.gameCode);
                        this.hideConnectionForm();
                        this.generateQRCode();
                        break;

                    case 'colors_assigned':
                        DEBUG.log('Received assigned colors:', data.colors.length);
                        this.createColorPalette(data.colors);
                        break;

                    case 'game_state':
                        DEBUG.log('Received game state:', data);

                        if (data.scores) {
                            DEBUG.log('Storing score data:', data.scores);
                            this.scores = data.scores;

                            this.updateCurrentAdminScore(data.scores);

                            if (data.teamMode) {
                                this.teamMode = data.teamMode;
                            }
                        }

                        this.updateGameProgressBar(data);

                        if (data.gamePhase) {
                            const previousPhase = this.gamePhase;
                            this.gamePhase = data.gamePhase;

                            if (this.gamePhase === 'results' && previousPhase !== 'results') {
                                DEBUG.log('Game transitioned to results phase, resetting countdown timer');
                                this.resetCountdownTimer();
                            }
                            else if (data.countdown && data.countdown.inCountdown) {
                                const secondsRemaining = data.countdown.secondsRemaining || 5;
                                DEBUG.log(`Game state includes countdown: ${secondsRemaining}s remaining (context: ${data.countdown.context})`);

                                if (this.gamePhase === 'countdown') {
                                    this.startCountdownToGuessing(secondsRemaining);
                                } else if (this.gamePhase === 'guessing' && data.countdown.context === 'perGuess') {
                                    this.startCountdownToGuessing(secondsRemaining);
                                }
                            }

                            const leftColumn = document.querySelector('.left-column');
                            if (leftColumn) {
                                leftColumn.classList.remove('guessing-phase', 'results-phase');

                                if (this.gamePhase === 'guessing') {
                                    leftColumn.classList.add('guessing-phase');
                                    DEBUG.log('Applying guessing-phase class due to game state');

                                    if (data.currentGuessingPlayer) {
                                        const playerWithQuestionType = {
                                            ...data.currentGuessingPlayer,
                                            questionType: data.questionType
                                        };
                                        this.displayGuessingInterface(playerWithQuestionType, data.myGuesses);
                                    }
                                } else if (this.gamePhase === 'results') {
                                    leftColumn.classList.add('results-phase');
                                    DEBUG.log('Applying results-phase class due to game state');
                                }
                            }

                            if (this.gamePhase === 'results') {
                                this.showGameResults();
                            }

                            this.updateUIForGamePhase();
                        }

                        if (data.hasOwnProperty('gameStarted')) {
                            this.gameStarted = data.gameStarted;
                        }

                        if (data.teamMode) {
                            this.teamMode = data.teamMode;
                            const teamOption = document.querySelector(`input[name="teamOrganization"][value="${this.teamMode}"]`);
                            if (teamOption) {
                                teamOption.checked = true;
                            }

                            if (data.teamId) {
                                this.adminTeamId = data.teamId;
                                this.adminTeamName = data.teamName;
                            }

                            this.updateAdminTeamBadge(data.teamId, data.teamName, data.teamMode);
                        }

                        if (data.teamNames) {
                            this.teamNames = data.teamNames;
                            this.teams = data.teams;
                        }

                        if (data.adminName) {
                            this.adminName = data.adminName;
                        }

                        if (data.answerTime && !localStorage.getItem('truths_and_lies_answer_time')) {
                            this.answerTime = data.answerTime;
                            const answerTimeInput = document.getElementById('answerTime');
                            if (answerTimeInput) {
                                answerTimeInput.value = this.answerTime;
                            }
                        }

                        if (data.roundsCount && !localStorage.getItem('truths_and_lies_rounds_count')) {
                            this.roundsCount = data.roundsCount;
                            const roundsCountInput = document.getElementById('roundsCount');
                            if (roundsCountInput) {
                                roundsCountInput.value = this.roundsCount;
                            }
                        }

                        if (data.examples && Array.isArray(data.examples)) {
                            this.updateCarouselWithExamples(data.examples);
                        }

                        if (data.players && Array.isArray(data.players)) {
                            DEBUG.log('Updating connected players:', data.players);
                            this.players.clear();
                            data.players.forEach(player => {
                                if (player.id && player.name) {
                                    this.players.set(player.id, {
                                        id: player.id,
                                        name: player.name,
                                        teamId: player.teamId || 1,
                                        ready: player.ready || false,
                                        submittedStatements: player.submittedStatements || false
                                    });
                                }
                            });
                            this.updatePlayersList();
                        }

                        if (this.gameSessionStarted) {
                            DEBUG.log('Truth and Lies game is in progress, updating UI');
                            DEBUG.log('Game state data:', data);

                            const gameInterface = document.querySelector('.game-interface');

                            if (gameInterface) {
                                gameInterface.classList.remove('hidden');
                                DEBUG.log('Game interface made visible');
                            }

                            if (data.gamePhase) {
                                this.gamePhase = data.gamePhase;
                                DEBUG.log('Game phase updated to:', this.gamePhase);

                                this.updateInterfaceForGamePhase();
                            }

                            if (data.timerSeconds !== undefined) {
                                DEBUG.log('Updating timer to:', data.timerSeconds);
                                this.updateGameTimerDisplay(data.timerSeconds);
                            }
                        }
                        break;

                    case 'player_joined':
                        DEBUG.log('Player joined:', data);
                        this.handlePlayerJoined(data);
                        break;

                    case 'player_left':
                        DEBUG.log('Player left:', data);
                        this.handlePlayerLeft(data);
                        break;

                    case 'player_submission':
                        if (this.gameSessionStarted) {
                            DEBUG.log('Processing player submission:', data);

                            const player = this.players.get(data.playerId);
                            if (player) {
                                player.statements = data.statements;
                                player.ready = true;

                                this.updatePlayerReadyStatus();

                                const allReady = Array.from(this.players.values()).every(p => p.ready);
                                if (allReady) {

                                }
                            }
                        }
                        break;

                    case 'player_guess':
                        if (this.gameSessionStarted && this.gamePhase === 'guessing') {
                            DEBUG.log('Processing player guess:', data);

                            if (data.scores) {
                                this.scores = data.scores;
                                this.updateCurrentAdminScore(data.scores);
                            }

                            const guessingPlayer = this.players.get(data.guessingPlayerId);
                            const targetPlayer = this.players.get(data.targetPlayerId);

                            if (guessingPlayer && targetPlayer) {
                                if (!guessingPlayer.guesses) guessingPlayer.guesses = [];

                                guessingPlayer.guesses.push({
                                    targetPlayerId: data.targetPlayerId,
                                    statementIndex: data.statementIndex,
                                    isCorrect: data.statementIndex === targetPlayer.lieIndex
                                });

                                guessingPlayer.guessedCurrentPlayer = true;

                                this.updateGuessDisplay(data.guessingPlayerId, data.targetPlayerId, data.statementIndex);

                                const allGuessed = Array.from(this.players.values()).every(p => p.guessedCurrentPlayer);
                                if (allGuessed) {
                                    DEBUG.log('All players have made their guesses for this round');
                                    this.advanceToNextPlayerOrResults();
                                }
                            }
                        }
                        break;

                    case 'player_ready_status':
                        if (this.gameSessionStarted) {
                            DEBUG.log('Processing player ready status:', data);

                            const player = this.players.get(data.playerId);
                            if (player) {
                                player.ready = data.ready;

                                this.updatePlayerReadyStatus();

                                if (this.gamePhase === 'submission') {
                                    const readyCount = Array.from(this.players.values()).filter(p => p.ready).length;
                                }
                            }
                        }
                        break;

                    case 'countdown_started':
                        DEBUG.log('Countdown started:', data);
                        this.gameSessionStarted = true;
                        this.gamePhase = 'countdown';

                        if (data.countdown && data.countdown.inCountdown) {
                            const secondsRemaining = data.countdown.secondsRemaining || data.seconds || 5;

                            this.startCountdownToGuessing(secondsRemaining);

                            DEBUG.log(`Starting countdown with ${secondsRemaining} seconds remaining`);
                        } else if (data.seconds) {
                            this.startCountdownToGuessing(data.seconds);
                        }
                        break;

                    case 'game_reset':
                        if (this.pendingRestart && this.players.size > 0) {
                            this.resetGameScreen();

                            const qrBoard = document.querySelector('.qr-board');
                            if (qrBoard) qrBoard.classList.add('hidden');

                            this.pendingRestart = false;
                            this.ws.send(JSON.stringify({
                                type: 'start_paint'
                            }));
                        }
                        break;
                }
            } catch (error) {
                DEBUG.log('Error processing message:', error);
            }
        };

        this.ws.onclose = () => {
            DEBUG.log('Disconnected from server');
            this.isConnected = false;

            if (this.gameStarted && this.gamePhase !== 'results') {
                this.updateConnectionStatus('Disconnected, attempting to reconnect...', false);

                setTimeout(() => {
                    if (!this.isConnected) {
                        this.reconnectAttempts++;
                        if (this.reconnectAttempts < this.maxReconnectAttempts) {
                            this.updateConnectionStatus(`Reconnecting... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`, false);
                            this.connectToServer();
                        } else {
                            this.updateConnectionStatus('Connection lost. Please refresh the page.', false);
                            const overlay = document.getElementById('connectionLostOverlay');
                            if (overlay) {
                                overlay.classList.remove('hidden');
                            }
                        }
                    }
                }, 3000);
            }
        };

        this.ws.onerror = (error) => {
            DEBUG.log('WebSocket error:', error);
            this.isConnected = false;
            this.updateConnectionStatus('Connection error, attempting to reconnect...', false);
        };
    }

    updateConnectionStatus(message, isConnected) {
        const status = document.getElementById('connectionStatus');
        if (status) {
            status.textContent = message;
            status.classList.remove('connected', 'error');
            status.classList.add(isConnected ? 'connected' : 'error');
        }
    }

    hideConnectionForm() {
        const form = document.getElementById('connectionForm');
        form.classList.add('hidden');
    }

    initializePlayersList() {
        const playersListContainer = document.getElementById('playersListContainer');
        const playersListToggle = document.getElementById('playersListToggle');

        if (playersListContainer && playersListToggle) {

            playersListContainer.classList.add('collapsed');


            playersListToggle.addEventListener('click', (e) => {
                playersListContainer.classList.toggle('collapsed');
                e.stopPropagation();
            });


            document.addEventListener('click', (e) => {

                if (!playersListContainer.classList.contains('collapsed') &&
                    !playersListContainer.contains(e.target)) {
                    playersListContainer.classList.add('collapsed');
                }
            });


            const playersListPanel = playersListContainer.querySelector('.players-list-panel');
            if (playersListPanel) {
                playersListPanel.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
            }


            this.updatePlayersList();
        }
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    updateCarouselWithExamples(examples) {
        DEBUG.log('Updating ticker with examples from server:', examples);

        const tickerContainer = document.getElementById('exampleTicker');
        if (!tickerContainer) return;

        tickerContainer.innerHTML = '';

        const wrapper = document.createElement('div');
        wrapper.className = 'ticker-wrapper';
        tickerContainer.appendChild(wrapper);

        const allStatements = [];

        if (Array.isArray(examples)) {
            examples.forEach(example => {
                if (Array.isArray(example) && example.length >= 3) {
                    allStatements.push(`Truth: ${example[0]}`);
                    allStatements.push(`Truth: ${example[1]}`);
                    allStatements.push(`Lie: ${example[2]}`);
                }
            });
        }

        if (allStatements.length > 0) {
            this.shuffleArray(allStatements);

            const maxStatements = Math.min(allStatements.length, 10);

            for (let i = 0; i < maxStatements; i++) {
                const tickerItem = document.createElement('div');
                tickerItem.className = 'ticker-item';
                tickerItem.textContent = allStatements[i];

                const delay = (i * 32) / maxStatements;

                tickerItem.style.animationName = 'ticker-fade';
                tickerItem.style.animationDelay = `${delay}s`;

                wrapper.appendChild(tickerItem);
            }
        }
    }

    setupNumberInputValidation(inputElement) {
        if (!inputElement) return;

        const minValue = parseInt(inputElement.getAttribute('min') || inputElement.getAttribute('data-min'), 10) || 1;
        const maxValue = parseInt(inputElement.getAttribute('max') || inputElement.getAttribute('data-max'), 10) || 100;

        let currentValue = parseInt(inputElement.value, 10);
        if (isNaN(currentValue) || currentValue < minValue) {
            inputElement.value = minValue;
        } else if (currentValue > maxValue) {
            inputElement.value = maxValue;
        }

        inputElement.addEventListener('blur', () => {
            const min = parseInt(inputElement.getAttribute('min') || inputElement.getAttribute('data-min'), 10) || 1;
            const max = parseInt(inputElement.getAttribute('max') || inputElement.getAttribute('data-max'), 10) || 100;

            let value = parseInt(inputElement.value.replace(/[^0-9]/g, ''), 10);

            if (isNaN(value) || value < min) {
                inputElement.value = min;
            } else if (value > max) {
                inputElement.value = max;
            } else {
                inputElement.value = value;
            }

            inputElement.dispatchEvent(new Event('change'));
        });

        inputElement.addEventListener('input', () => {
            if (!/^\d*$/.test(inputElement.value)) {
                inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
            }
        });

        inputElement.addEventListener('keydown', (e) => {
            const min = parseInt(inputElement.getAttribute('min') || inputElement.getAttribute('data-min'), 10) || 1;
            const max = parseInt(inputElement.getAttribute('max') || inputElement.getAttribute('data-max'), 10) || 100;
            let currentValue = parseInt(inputElement.value, 10) || 0;

            if (e.key === 'ArrowUp') {
                const newValue = Math.min(currentValue + 1, max);
                inputElement.value = newValue;
                e.preventDefault();
                inputElement.dispatchEvent(new Event('change'));
            } else if (e.key === 'ArrowDown') {
                const newValue = Math.max(currentValue - 1, min);
                inputElement.value = newValue;
                e.preventDefault();
                inputElement.dispatchEvent(new Event('change'));
            }
        });
    }

    initializeGameOptions() {
        const teamOptions = document.querySelectorAll('input[name="teamOrganization"]');
        if (teamOptions.length) {
            teamOptions.forEach(option => {
                if (option.value === this.teamMode) {
                    option.checked = true;
                }
                option.addEventListener('change', (e) => {
                    this.teamMode = e.target.value;

                    if (this.ws && this.isConnected) {
                        this.ws.send(JSON.stringify({
                            type: 'set_team_mode',
                            mode: this.teamMode
                        }));

                        DEBUG.log('Team mode changed to:', this.teamMode);
                    }
                });
            });
        }

        const answerTimeInput = document.getElementById('answerTime');
        if (answerTimeInput) {
            answerTimeInput.value = this.answerTime;
            answerTimeInput.addEventListener('change', (e) => {
                this.answerTime = parseInt(e.target.value) || 10;
                localStorage.setItem('truths_and_lies_answer_time', this.answerTime);

                if (this.ws && this.isConnected) {
                    this.ws.send(JSON.stringify({
                        type: 'update_game_settings',
                        answerTime: this.answerTime
                    }));
                }
            });

            this.setupNumberInputValidation(answerTimeInput);
        }

        const roundsCountInput = document.getElementById('roundsCount');
        if (roundsCountInput) {
            roundsCountInput.value = this.roundsCount;
            roundsCountInput.addEventListener('change', (e) => {
                this.roundsCount = parseInt(e.target.value) || 1;
                localStorage.setItem('truths_and_lies_rounds_count', this.roundsCount);

                this.generateStatementInputs();

                if (this.ws && this.isConnected) {
                    this.ws.send(JSON.stringify({
                        type: 'update_game_settings',
                        roundsCount: this.roundsCount
                    }));
                }
            });

            this.setupNumberInputValidation(roundsCountInput);
        }

        this.generateStatementInputs();

        if (this.gameCode) {
            this.updateQRCode();
        }
    }

    generateStatementInputs() {
        const container = document.getElementById('dynamicStatementInputs');
        if (!container) return;

        const existingValues = {};
        for (let i = 1; i <= 5; i++) {
            const truthId1 = `adminTruth1_${i}`;
            const truthId2 = `adminTruth2_${i}`;
            const lieId = `adminLie_${i}`;

            const truthEl1 = document.getElementById(truthId1);
            const truthEl2 = document.getElementById(truthId2);
            const lieEl = document.getElementById(lieId);

            if (truthEl1) existingValues[truthId1] = truthEl1.value;
            if (truthEl2) existingValues[truthId2] = truthEl2.value;
            if (lieEl) existingValues[lieId] = lieEl.value;
        }

        const oldTruth1 = document.getElementById('adminTruth1');
        const oldTruth2 = document.getElementById('adminTruth2');
        const oldLie = document.getElementById('adminLie');

        if (oldTruth1 && !existingValues['adminTruth1_1']) existingValues['adminTruth1_1'] = oldTruth1.value;
        if (oldTruth2 && !existingValues['adminTruth2_1']) existingValues['adminTruth2_1'] = oldTruth2.value;
        if (oldLie && !existingValues['adminLie_1']) existingValues['adminLie_1'] = oldLie.value;

        container.innerHTML = '';

        for (let i = 1; i <= this.roundsCount; i++) {
            if (this.roundsCount > 1) {
                const titleContainer = document.createElement('div');
                titleContainer.className = 'round-title-container';

                const setTitle = document.createElement('h4');
                setTitle.className = 'set-title';
                setTitle.textContent = `Round ${i}`;
                titleContainer.appendChild(setTitle);

                container.appendChild(titleContainer);
            }

            const setContainer = document.createElement('div');
            setContainer.className = 'statement-set';

            const truthDiv1 = document.createElement('div');
            truthDiv1.className = 'statement-input statement-input-truth';

            const truthLabel1 = document.createElement('label');
            const truthId1 = `adminTruth1_${i}`;
            truthLabel1.setAttribute('for', truthId1);
            truthLabel1.textContent = 'First truth';

            const truthTextarea1 = document.createElement('textarea');
            truthTextarea1.id = truthId1;
            truthTextarea1.value = existingValues[truthId1] || '';

            truthTextarea1.addEventListener('input', () => {
                this.validateGameCanStart();
                this.saveDynamicStatementsToStorage();
            });

            truthDiv1.appendChild(truthLabel1);
            truthDiv1.appendChild(truthTextarea1);
            setContainer.appendChild(truthDiv1);

            const truthDiv2 = document.createElement('div');
            truthDiv2.className = 'statement-input statement-input-truth';

            const truthLabel2 = document.createElement('label');
            const truthId2 = `adminTruth2_${i}`;
            truthLabel2.setAttribute('for', truthId2);
            truthLabel2.textContent = 'Second truth';

            const truthTextarea2 = document.createElement('textarea');
            truthTextarea2.id = truthId2;
            truthTextarea2.value = existingValues[truthId2] || '';

            truthTextarea2.addEventListener('input', () => {
                this.validateGameCanStart();
                this.saveDynamicStatementsToStorage();
            });

            truthDiv2.appendChild(truthLabel2);
            truthDiv2.appendChild(truthTextarea2);
            setContainer.appendChild(truthDiv2);

            const lieDiv = document.createElement('div');
            lieDiv.className = 'statement-input statement-input-lie';

            const lieLabel = document.createElement('label');
            const lieId = `adminLie_${i}`;
            lieLabel.setAttribute('for', lieId);
            lieLabel.textContent = 'One lie';

            const lieTextarea = document.createElement('textarea');
            lieTextarea.id = lieId;
            lieTextarea.value = existingValues[lieId] || '';

            lieTextarea.addEventListener('input', () => {
                this.validateGameCanStart();
                this.saveDynamicStatementsToStorage();
            });

            lieDiv.appendChild(lieLabel);
            lieDiv.appendChild(lieTextarea);
            setContainer.appendChild(lieDiv);

            container.appendChild(setContainer);
        }

        this.loadDynamicStatementsFromStorage();
    }

    updateAdminTeamBadge(teamId, teamName, teamMode) {
        const shouldShowTeam = teamMode && teamMode !== 'allVsAll' && teamId > 0 && teamName;

        const adminTeamBadge = document.getElementById('adminTeamBadge');
        const teamNameElement = adminTeamBadge?.querySelector('.team-name');

        if (adminTeamBadge) {
            if (shouldShowTeam) {
                if (teamNameElement) {
                    teamNameElement.textContent = teamName;
                }
                adminTeamBadge.classList.remove('hidden');
            } else {
                adminTeamBadge.classList.add('hidden');
            }
        }
    }

    updateQRCode() {
        const qrCodeContainer = document.getElementById('qrCode');
        if (!qrCodeContainer || !this.gameCode) return;

        qrCodeContainer.innerHTML = '';

        const joinUrl = `${window.location.origin}${window.location.pathname.replace('index.html', 'player.html')}?code=${this.gameCode}`;

        new QRCode(qrCodeContainer, {
            text: joinUrl,
            width: 128,
            height: 128,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });

        const joinLinkContainer = document.getElementById('joinLink');
        if (joinLinkContainer) {
            joinLinkContainer.textContent = joinUrl;
            joinLinkContainer.href = joinUrl;
        }
    }

    initializeEventListeners() {
        const startGameBtn = document.getElementById('start-game-button');
        if (startGameBtn) {
            startGameBtn.addEventListener('click', () => {
                this.startGame();
            });
        }

        const adminTruth1 = document.getElementById('adminTruth1');
        const adminTruth2 = document.getElementById('adminTruth2');
        const adminLie = document.getElementById('adminLie');

        if (adminTruth1 && adminTruth2 && adminLie) {
            this.loadAdminStatementsFromStorage();

            [adminTruth1, adminTruth2, adminLie].forEach(input => {
                input.addEventListener('input', () => {
                    this.validateAdminExamples();
                    this.saveAdminStatementsToStorage();
                });
            });
        }
    }

    validateAdminExamples() {
        const adminTruth1 = document.getElementById('adminTruth1');
        const adminTruth2 = document.getElementById('adminTruth2');
        const adminLie = document.getElementById('adminLie');

        if (!adminTruth1 || !adminTruth2 || !adminLie) return;

        this.validateGameCanStart();
    }

    saveDynamicStatementsToStorage() {
        try {
            const statements = {};

            for (let i = 1; i <= this.roundsCount; i++) {
                const truth1 = document.getElementById(`adminTruth1_${i}`);
                const truth2 = document.getElementById(`adminTruth2_${i}`);
                const lie = document.getElementById(`adminLie_${i}`);

                if (truth1 && truth2 && lie) {
                    statements[`set_${i}`] = {
                        truth1: truth1.value,
                        truth2: truth2.value,
                        lie: lie.value
                    };
                }
            }

            localStorage.setItem('truths_and_lies_admin_dynamic_statements', JSON.stringify(statements));
            DEBUG.log('Dynamic statements saved to localStorage');

        } catch (error) {
            DEBUG.log('Error saving dynamic statements to localStorage:', error);
        }
    }

    loadDynamicStatementsFromStorage() {
        try {
            const savedData = localStorage.getItem('truths_and_lies_admin_dynamic_statements');
            if (!savedData) return;

            const savedStatements = JSON.parse(savedData);

            Object.keys(savedStatements).forEach(setKey => {
                const set = savedStatements[setKey];
                const setNumber = parseInt(setKey.replace('set_', ''));

                if (setNumber && !isNaN(setNumber) && setNumber <= this.roundsCount) {
                    const truth1 = document.getElementById(`adminTruth1_${setNumber}`);
                    const truth2 = document.getElementById(`adminTruth2_${setNumber}`);
                    const lie = document.getElementById(`adminLie_${setNumber}`);

                    if (truth1) truth1.value = set.truth1 || '';
                    if (truth2) truth2.value = set.truth2 || '';
                    if (lie) lie.value = set.lie || '';
                }
            });

            DEBUG.log('Dynamic statements loaded from localStorage');
        } catch (error) {
            DEBUG.log('Error loading dynamic statements from storage:', error);
        }
    }

    clearDynamicStatementsFromStorage() {
        return;
        try {
            localStorage.removeItem('truths_and_lies_admin_dynamic_statements');
            DEBUG.log('Dynamic statements cleared from localStorage');

            for (let i = 1; i <= this.roundsCount; i++) {
                const truth1 = document.getElementById(`adminTruth1_${i}`);
                const truth2 = document.getElementById(`adminTruth2_${i}`);
                const lie = document.getElementById(`adminLie_${i}`);

                if (truth1) truth1.value = '';
                if (truth2) truth2.value = '';
                if (lie) lie.value = '';
            }

            this.validateGameCanStart();
        } catch (error) {
            DEBUG.log('Error clearing dynamic statements from localStorage:', error);
        }
    }

    startGame() {
        if (!this.validateGameCanStart()) {
            return;
        }

        const totalPlayers = this.players.size;
        const readyPlayers = Array.from(this.players.values()).filter(player => player.submittedStatements).length;
        const allPlayersReady = readyPlayers === totalPlayers;

        if (this.alwaysShowWaitTimePopup || (!allPlayersReady && readyPlayers >= (this.roundsCount - 1))) {
            const waitTimePopup = document.getElementById('waitTimePopup');
            const startWithWaitBtn = document.getElementById('startWithWaitBtn');
            const startImmediatelyBtn = document.getElementById('startImmediatelyBtn');
            const closeWaitTimePopupBtn = document.getElementById('closeWaitTimePopup');
            const waitTimeInput = document.getElementById('waitTimeInput');

            waitTimeInput.value = this.waitTime;

            const pendingPlayers = totalPlayers - readyPlayers;

            waitTimePopup.classList.remove('hidden');

            waitTimeInput.addEventListener('keydown', () => {
                const newValue = parseInt(waitTimeInput.value) || 30;
                this.waitTime = newValue;
                localStorage.setItem('truths_and_lies_wait_time', newValue);
            });

            this.setupNumberInputValidation(waitTimeInput);

            const handleStartWithWait = () => {
                let waitTime = parseInt(waitTimeInput.value, 10);

                waitTimePopup.classList.add('hidden');

                const statusMessage = `Starting in ${waitTime} seconds. Waiting for more players to submit...`;
                this.broadcastGameStatusMessage(statusMessage, false);

                this.countdownSeconds = waitTime;

                this.sendStartGameMessage();
                this.gameStarted = true;
                this.gamePhase = 'countdown';

                this.startCountdownToGuessing(waitTime);
                this.updateStartButton();

                startWithWaitBtn.removeEventListener('click', handleStartWithWait);
                startImmediatelyBtn.removeEventListener('click', handleStartImmediately);
                closeWaitTimePopupBtn.removeEventListener('click', () => {});
            };

            const handleStartImmediately = () => {
                waitTimePopup.classList.add('hidden');

                this.countdownSeconds = 3;

                this.sendStartGameMessage();
                this.gameStarted = true;
                this.gamePhase = 'countdown';

                this.startCountdownToGuessing(this.countdownSeconds);
                this.updateStartButton();

                startWithWaitBtn.removeEventListener('click', handleStartWithWait);
                startImmediatelyBtn.removeEventListener('click', handleStartImmediately);
                closeWaitTimePopupBtn.removeEventListener('click', () => {});
            };

            startWithWaitBtn.addEventListener('click', handleStartWithWait);
            startImmediatelyBtn.addEventListener('click', handleStartImmediately);

            closeWaitTimePopupBtn.addEventListener('click', () => {
                waitTimePopup.classList.add('hidden');
            });
        } else {
            this.sendStartGameMessage();
            this.gameStarted = true;
            this.gamePhase = 'countdown';

            this.startCountdownToGuessing(3);
            this.updateStartButton();
        }
    }

    sendStartGameMessage() {
        if (this.ws && this.isConnected) {
            const countdownSeconds = this.countdownSeconds || 5;
            const container = document.getElementById('dynamicStatementInputs');
            const useDynamicInputs = container && container.children.length > 0;

            const statementSets = [];

            for (let i = 1; i <= this.roundsCount; i++) {
                const truth1 = document.getElementById(`adminTruth1_${i}`);
                const truth2 = document.getElementById(`adminTruth2_${i}`);
                const lie = document.getElementById(`adminLie_${i}`);

                if (truth1 && truth2 && lie) {
                    statementSets.push({
                        round: i,
                        truths: [truth1.value.trim(), truth2.value.trim()],
                        lie: lie.value.trim()
                    });
                }
            }

            this.ws.send(JSON.stringify({
                type: 'start_game',
                teamMode: this.teamMode,
                answerTime: this.answerTime,
                roundsCount: this.roundsCount,
                countdownSeconds: this.countdownSeconds,
                statementSets: statementSets
            }));
        }
    }

    startCountdownToGuessing(seconds) {
        DEBUG.log(`Starting countdown to guessing: ${seconds} seconds`);
        const timerElement = document.getElementById('countdownTimer');
        const timerDisplay = timerElement?.querySelector('.timer-display');
        const timerProgress = timerElement?.querySelector('.timer-circle-progress');

        if (!timerElement || !timerDisplay || !timerProgress) {
            DEBUG.log('Countdown timer elements not found');
            return;
        }

        timerElement.classList.remove('timer-state-green', 'timer-state-orange', 'timer-state-red');

        timerElement.classList.add('timer-state-green');

        timerElement.style.visibility = 'visible';
        timerElement.style.display = 'block';
        timerElement.classList.add('active');

        timerDisplay.textContent = seconds;

        const radius = 45;
        const circumference = 2 * Math.PI * radius;

        timerProgress.style.strokeDasharray = `${circumference} ${circumference}`;
        timerProgress.style.strokeDashoffset = '0';

        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }

        let timeLeft = seconds;
        this.countdownInterval = setInterval(() => {
            timeLeft--;

            timerDisplay.textContent = timeLeft;

            const offset = circumference * (1 - timeLeft / seconds);
            timerProgress.style.strokeDashoffset = offset;

            const percentRemaining = timeLeft / seconds;

            timerElement.classList.remove('timer-state-green', 'timer-state-orange', 'timer-state-red');

            if (timeLeft === 2 && this.gamePhase === 'guessing') {
                const targetPlayerId = this.currentGuessingPlayer.id || this.currentGuessingPlayer.playerId;
                console.log('auto-check', targetPlayerId, this.currentGuessingPlayer);
                const isOwnStatements = targetPlayerId === 'admin';
                if (targetPlayerId && !isOwnStatements && 1 === 2) {
                    DEBUG.log('Auto-selecting and submitting random guess for admin');
                    const availableOptions = document.querySelectorAll('input[name="guess"]');
                    console.log('auto-check', availableOptions);
                    if (availableOptions.length > 0) {
                        const randomIndex = Math.floor(Math.random() * availableOptions.length);
                        const randomOption = availableOptions[randomIndex];

                        randomOption.checked = true;

                        const radioLabel = randomOption.closest('label');
                        if (radioLabel) {
                            radioLabel.classList.add('auto-selected');
                            radioLabel.setAttribute('data-auto-action', 'auto-selected');
                        }
                    }
                }
            }

            if (percentRemaining <= 0.3) {
                timerElement.classList.add('timer-state-red');
            } else if (percentRemaining <= 0.6) {
                timerElement.classList.add('timer-state-orange');
            } else {
                timerElement.classList.add('timer-state-green');
            }

            if (timeLeft <= 0) {
                clearInterval(this.countdownInterval);
                this.countdownInterval = null;

                timerElement.classList.remove('active');
                timerElement.classList.remove('timer-state-green', 'timer-state-orange', 'timer-state-red');
                timerDisplay.textContent = '--';

                DEBUG.log('Countdown complete, waiting for server to transition to guessing phase');
            }
        }, 1000);
    }

    resetCountdownTimer() {
        DEBUG.log('Resetting countdown timer');

        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }

        const timerElement = document.getElementById('countdownTimer');
        const timerDisplay = timerElement?.querySelector('.timer-display');
        const timerProgress = timerElement?.querySelector('.timer-circle-progress');

        if (timerElement) {
            timerElement.classList.remove('active');
            timerElement.classList.remove('timer-state-green', 'timer-state-orange', 'timer-state-red');

            if (timerDisplay) {
                timerDisplay.textContent = '--';
            }

            if (timerProgress) {
                timerProgress.style.strokeDashoffset = '0';
            }
        }
    }

    transitionToGuessingPhase() {
        this.gamePhase = 'guessing';

        const leftColumn = document.querySelector('.left-column');
        if (leftColumn) {
            leftColumn.classList.add('guessing-phase');
        }

        this.updateUIForGamePhase();

        if (this.ws && this.isConnected) {
            this.ws.send(JSON.stringify({
                type: 'start_guessing_phase'
            }));
        }

        DEBUG.log('Transitioned to guessing phase');
    }

    validateGameCanStart() {
        const startGameBtn = document.getElementById('start-game-button');
        const startGameMessage = document.getElementById('start-game-message');

        if (startGameMessage) {
            startGameMessage.textContent = '';
            startGameMessage.classList.remove('ready');

            this.broadcastGameStatusMessage('', false);
        }
        if (startGameBtn) startGameBtn.classList.remove('inactive');

        let allFilled = true;

        const container = document.getElementById('dynamicStatementInputs');
        const useDynamicInputs = container && container.children.length > 0;

        if (useDynamicInputs) {
            for (let i = 1; i <= this.roundsCount; i++) {
                const truth1 = document.getElementById(`adminTruth1_${i}`);
                const truth2 = document.getElementById(`adminTruth2_${i}`);
                const lie = document.getElementById(`adminLie_${i}`);

                if (!truth1 || !truth2 || !lie) {
                    allFilled = false;
                    break;
                }

                const setFilled = truth1.value.trim() &&
                                 truth2.value.trim() &&
                                 lie.value.trim();

                if (!setFilled) {
                    allFilled = false;
                    break;
                }
            }
        } else {
            const adminTruth1 = document.getElementById('adminTruth1');
            const adminTruth2 = document.getElementById('adminTruth2');
            const adminLie = document.getElementById('adminLie');

            if (!adminTruth1 || !adminTruth2 || !adminLie) {
                return false;
            }

            allFilled = adminTruth1.value.trim() &&
                        adminTruth2.value.trim() &&
                        adminLie.value.trim();
        }

        if (!allFilled) {
            const message = 'Waiting for admin';
            if (startGameMessage) startGameMessage.textContent = message;
            if (startGameBtn) startGameBtn.classList.add('inactive');
            this.broadcastGameStatusMessage(message, false);
            return false;
        }

        if (this.players.size < 1) {
            const message = 'At least one other player must join.';
            if (startGameMessage) startGameMessage.textContent = message;
            if (startGameBtn) startGameBtn.classList.add('inactive');
            this.broadcastGameStatusMessage(message, false);
            return false;
        }

        const totalPlayers = this.players.size;
        const readyPlayers = Array.from(this.players.values()).filter(player => player.submittedStatements).length;
        const totalResponders = readyPlayers + 1;

        if (readyPlayers < totalPlayers) {
            const remainingCount = totalPlayers - readyPlayers;
            const playerText = remainingCount === 1 ? 'player needs' : 'players need';
            const message = `${remainingCount} more ${playerText} to submit statements.`;
            if (startGameMessage) startGameMessage.textContent = message;

            if (startGameBtn) startGameBtn.classList.remove('inactive');
            this.broadcastGameStatusMessage(message, true);

            return true;
        }

        if (totalPlayers < 1) {
            const message = `Need at least one more player to start the game.`;
            if (startGameMessage) startGameMessage.textContent = message;
            if (startGameBtn) startGameBtn.classList.add('inactive');
            this.broadcastGameStatusMessage(message, false);
            return false;
        }

        const readyMessage = 'Ready to start game!';
        if (startGameMessage) {
            startGameMessage.textContent = readyMessage;
            startGameMessage.classList.add('ready');
        }
        this.broadcastGameStatusMessage(readyMessage, true);
        return true;
    }

    broadcastGameStatusMessage(message, isReady) {
        if (!this.ws || !this.isConnected) return;

        this.ws.send(JSON.stringify({
            type: 'game_status_message',
            message: message,
            isReady: isReady
        }));
    }

    updateTimerDisplay(seconds) {
        const timerDisplay = document.getElementById('timerDisplay');
        const timerCircle = document.getElementById('timerCircle');

        if (timerDisplay && timerCircle) {
            timerDisplay.textContent = seconds;

            const circumference = 2 * Math.PI * 45;
            const offset = circumference - (seconds / this.answerTime) * circumference;
            timerCircle.style.strokeDashoffset = offset;
        }
    }

    timerComplete() {
        if (this.ws && this.isConnected) {
            this.ws.send(JSON.stringify({
                type: 'timer_completed'
            }));
        }

        if (this.gamePhase === 'submission') {
            this.gamePhase = 'guessing';
            this.updateUIForGamePhase();
        }
    }

    displayGuessingInterface(currentPlayer, myGuesses) {
        DEBUG.log('Displaying guessing interface for player:', currentPlayer.name);

        this.currentGuessingPlayer = currentPlayer;
        const playerId = currentPlayer.id || currentPlayer.playerId;
        const isOwnStatements = playerId === 'admin';
        DEBUG.log('Admin ID Check:', isOwnStatements, playerId, 'admin', currentPlayer);

        this.currentQuestionType = currentPlayer.questionType || 'truth';
        if (isOwnStatements) {
            DEBUG.log('These are admin\'s own statements - will show in inactive state');
        }

        const leftColumn = document.querySelector('.left-column');
        if (leftColumn) {
            leftColumn.classList.add('guessing-phase');
        }

        const playerNameElement = document.getElementById('current-player-name');
        if (playerNameElement) {
            playerNameElement.textContent = currentPlayer.name;
        }

        const statementsContainer = document.getElementById('statements-container');
        if (!statementsContainer) {
            DEBUG.log('Statements container not found');
            return;
        }

        statementsContainer.innerHTML = '';

        if (!currentPlayer.statements || currentPlayer.statements.length === 0) {
            statementsContainer.innerHTML = '<p class="no-statements">No statements available</p>';
            return;
        }

        if (isOwnStatements) {
            const messageDiv = document.createElement('div');
            messageDiv.className = 'own-statements-message';
            messageDiv.textContent = 'This is your turn! Other players are guessing your statements.';
            statementsContainer.appendChild(messageDiv);
        }

        let previousGuess = null;
        if (currentPlayer.setId && myGuesses && myGuesses[currentPlayer.setId] !== undefined) {
            previousGuess = myGuesses[currentPlayer.setId];
            DEBUG.log('Found previous guess for this statement set:', previousGuess);
        }

        currentPlayer.statements.forEach((statement, index) => {
            const statementDiv = document.createElement('div');
            statementDiv.className = 'statement-option';

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'guess';
            radio.id = `statement${index+1}`;
            radio.value = statement.index;

            if (isOwnStatements) {
                radio.classList.add("inactive");
                radio.tabIndex = -1;
            } else {
                radio.classList.remove("inactive");
                radio.tabIndex = 0;
            }

            const label = document.createElement('label');
            label.htmlFor = `statement${index+1}`;
            label.className = 'statement-text';
            label.textContent = statement.text;

            statementDiv.appendChild(radio);
            statementDiv.appendChild(label);

            if (isOwnStatements) {
                statementDiv.classList.add('inactive');
            } else {
                statementDiv.classList.remove('inactive');
                if (previousGuess !== null) {
                    if (previousGuess === index) {
                        radio.checked = true;
                        statementDiv.style.opacity = '0.8';
                        statementDiv.style.borderColor = 'var(--primary-color)';
                    }
                } else {
                    statementDiv.addEventListener('click', function(e) {
                        e.preventDefault();
                        radio.checked = true;

                        statementDiv.style.opacity = '0.8';
                        statementDiv.style.borderColor = 'var(--primary-color)';

                        this.submitGuess(currentPlayer.playerId, index);
                    }.bind(this));
                }
            }

            statementsContainer.appendChild(statementDiv);
        });

        const guessInstruction = document.querySelector('.guessing-instruction p');
        if (guessInstruction) {
            guessInstruction.textContent = `Select one ${this.currentQuestionType === 'truth' ? 'Truth' : 'Lie'}`;
            guessInstruction.parentElement.setAttribute('data-question-type', this.currentQuestionType);
        }

        const submitButton = document.getElementById('submit-guess-button');
        if (submitButton) {
            if (isOwnStatements) {
                submitButton.classList.add('inactive');
                submitButton.textContent = 'These are your statements';
            } else {
                submitButton.style.display = 'none';
            }
        }
    }

    submitGuess(playerId, statementIndex) {
        DEBUG.log(`Submitting guess for player ${playerId}: statement ${statementIndex} is a truth`);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'submit_guess',
                playerId: 'admin',
                targetPlayerId: playerId,
                guessIndex: statementIndex
            }));

            const submitButton = document.getElementById('submit-guess-button');
            if (submitButton) {
                submitButton.classList.add('inactive');
                submitButton.textContent = 'Guess Submitted';
            }

            const guessStatus = document.querySelector('.guess-status p');
            if (guessStatus) {
                guessStatus.textContent = 'Your guess has been submitted!';
            }
        } else {
            DEBUG.log('WebSocket not connected');
            GameAdmin.showError('Not connected to server. Please refresh the page.');
        }
    }

    updateUIForGamePhase() {
        const gameOptionsColumn = document.getElementById('gameOptionsColumn');
        const gameControlColumn = document.getElementById('gameControlColumn');
        const startGameBtn = document.getElementById('start-game-button');

        if (!this.gameStarted) {
            if (gameOptionsColumn) gameOptionsColumn.classList.remove('inactive');
            if (startGameBtn) startGameBtn.setAttribute('aria-hidden', 'false');
            return;
        }

        if (gameOptionsColumn) gameOptionsColumn.classList.add('inactive');

        switch (this.gamePhase) {
            case 'countdown':
                if (startGameBtn) {
                    startGameBtn.classList.add('inactive');
                    this.updateStartGameButtonText(0, 0, 'Starting Soon...');
                }
                if (gameControlColumn) {
                    gameControlColumn.classList.add('countdown-phase');
                }
                break;

            case 'submission':
                if (startGameBtn) {
                    startGameBtn.classList.add('inactive');
                    this.updateStartGameButtonText(0, 0, 'Game in Progress');
                }
                if (gameControlColumn) gameControlColumn.classList.add('submission-phase');
                break;

            case 'guessing':
                if (startGameBtn) {
                    startGameBtn.classList.add('inactive');
                    this.updateStartGameButtonText(0, 0, 'Guessing in Progress');
                }
                if (gameControlColumn) {
                    gameControlColumn.classList.remove('submission-phase');
                    gameControlColumn.classList.add('guessing-phase');
                }
                break;

            case 'results':
                if (startGameBtn) {
                    startGameBtn.classList.remove('inactive');
                    this.updateStartGameButtonText(0, 0, 'New Game');
                }
                if (gameControlColumn) {
                    gameControlColumn.classList.remove('submission-phase');
                    gameControlColumn.classList.remove('guessing-phase');
                    gameControlColumn.classList.add('results-phase');
                }
                this.gameStarted = false;
                break;

            default:
                this.gameStarted = false;
                this.updateUIForGamePhase();
        }
    }

    updateStartButton() {
        const startGameBtn = document.getElementById('start-game-button');
        if (!startGameBtn) return;

        if (this.gameStarted) {
            this.updateStartGameButtonText(0, 0, 'Game in Progress');
            startGameBtn.classList.add('inactive');
        } else {
            const readyCount = Array.from(this.players.values()).filter(p => p.ready).length;
            const totalPlayers = this.players.size + (this.adminName ? 1 : 0);
            const displayReadyCount = this.adminName ? readyCount + 1 : readyCount;
            this.updateStartGameButtonText(displayReadyCount, totalPlayers);
            this.validateAdminExamples();
        }
    }

    initializeAdminNameModal() {
        const adminNameModal = document.getElementById('adminNameModal');
        const adminNameInput = document.getElementById('adminName');
        const saveAdminNameBtn = document.getElementById('saveAdminName');

        const savedAdminName = localStorage.getItem('truth_and_lies_admin_name');
        if (savedAdminName) {
            this.adminName = savedAdminName;
            DEBUG.log('Admin name loaded from localStorage:', savedAdminName);

            this.shouldSendAdminName = true;
        }

        if (!this.adminName) {
            adminNameModal.classList.add('visible');
            DEBUG.log('Admin name not found, showing modal');
        }


        if (adminNameInput && saveAdminNameBtn) {

            if (this.adminName) {
                adminNameInput.value = this.adminName;
            }


            saveAdminNameBtn.addEventListener('click', () => {
                const name = adminNameInput.value.trim();
                if (name) {
                    this.adminName = name;
                    localStorage.setItem('truth_and_lies_admin_name', name);
                    adminNameModal.classList.remove('visible');


                    this.updatePlayersList();


                    if (this.ws && this.isConnected) {
                        this.ws.send(JSON.stringify({
                            type: 'admin_name_update',
                            name: name
                        }));
                    }
                } else {

                    adminNameInput.classList.add('error');
                    setTimeout(() => adminNameInput.classList.remove('error'), 1000);
                }
            });


            adminNameInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    saveAdminNameBtn.click();
                }
            });


            adminNameInput.addEventListener('input', () => {
                adminNameInput.classList.remove('error');
            });
        }
    }

    checkAdminName() {

        if (!this.adminName) {
            const adminNameModal = document.getElementById('adminNameModal');
            if (adminNameModal) {
                adminNameModal.classList.add('visible');
            }
            return false;
        }
        return true;
    }

    updatePlayersList() {
        const connectedPlayers = document.getElementById('connected-players');
        const playerCountBadge = document.getElementById('players-count-badge');

        if (playerCountBadge) {
            const readyCount = Array.from(this.players.values()).filter(p => p.ready).length;
            const totalPlayers = this.players.size + (this.adminName ? 1 : 0);

            playerCountBadge.textContent = `${this.adminName ? readyCount + 1 : readyCount}/${totalPlayers}`;
        }

        if (!connectedPlayers) {
            this.validateGameCanStart();
            return;
        }

        connectedPlayers.innerHTML = '';

        if (this.players.size === 0 && !this.adminName) {
            connectedPlayers.textContent = 'No players connected';
            return;
        }

        if (this.teamMode === 'randomTeams' || this.teamMode === 'adminTeams') {
            const teamContainers = {};
            const playersByTeam = {};

            this.players.forEach((player, id) => {
                const teamId = player.teamId || 1;
                if (!playersByTeam[teamId]) {
                    playersByTeam[teamId] = [];
                }
                playersByTeam[teamId].push({id, ...player});
            });

            if (this.adminName && this.adminTeamId) {
                const adminTeamId = this.adminTeamId;
                if (!playersByTeam[adminTeamId]) {
                    playersByTeam[adminTeamId] = [];
                }

                playersByTeam[adminTeamId].push({
                    id: 'admin',
                    name: this.adminName + ' (Admin)',
                    teamId: adminTeamId,
                    teamName: this.adminTeamName,
                    isAdmin: true,
                    submittedStatements: true,
                    ready: true
                });
            }

            let teamIds = [];

            if (this.teams && typeof this.teams === 'object') {
                teamIds = Object.keys(this.teams);
            }

            Object.keys(playersByTeam).forEach(teamId => {
                if (!teamIds.includes(teamId)) {
                    teamIds.push(teamId);
                }
            });

            teamIds.sort((a, b) => {
                if (a == this.adminTeamId) return -1;
                if (b == this.adminTeamId) return 1;
                return parseInt(a) - parseInt(b);
            });

            teamIds.forEach(team => {
                const teamPlayers = playersByTeam[team] || [];

                if (teamPlayers.length === 0 && this.teamMode === 'allVsAll') {
                    return;
                }

                const teamName = this.teamNames[team] || `Team ${team}`;

                const teamHeader = document.createElement('h4');
                teamHeader.className = 'team-header';
                teamHeader.textContent = teamName;
                teamHeader.dataset.teamId = team;
                teamHeader.title = 'Click to edit team name';

                teamHeader.addEventListener('click', (e) => {
                    if (this.gamePhase !== 'setup' && this.gamePhase !== 'answering') return;

                    if (teamHeader.classList.contains('editing')) return;

                    const currentName = teamHeader.textContent;
                    teamHeader.classList.add('editing');

                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'edit-team-name';
                    input.value = currentName;

                    teamHeader.textContent = '';
                    teamHeader.appendChild(input);

                    input.focus();
                    input.select();

                    let saveHandled = false;

                    const saveTeamName = () => {
                        if (saveHandled) return;
                        saveHandled = true;

                        teamHeader.classList.remove('editing');

                        const newName = input.value.trim();
                        if (newName && newName !== currentName) {
                            teamHeader.textContent = newName;
                            this.teamNames[team] = newName;

                            if (this.ws && this.isConnected) {
                                this.ws.send(JSON.stringify({
                                    type: 'update_team_name',
                                    teamId: team,
                                    newName: newName
                                }));
                                DEBUG.log(`Updated team ${team} name to: ${newName}`);
                            }
                        } else {
                            teamHeader.textContent = currentName;
                        }
                    };

                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            saveTeamName();
                        } else if (e.key === 'Escape') {
                            teamHeader.classList.remove('editing');
                            teamHeader.textContent = currentName;
                            saveHandled = true;
                        }
                    });

                    input.addEventListener('blur', saveTeamName);

                    e.stopPropagation();
                });

                connectedPlayers.appendChild(teamHeader);

                const teamList = document.createElement('ul');
                teamList.className = 'team-players';
                teamList.dataset.teamId = team;

                const sortedTeamPlayers = [...teamPlayers].sort((a, b) => {
                    if (a.isAdmin) return -1;
                    if (b.isAdmin) return 1;
                    return a.name.localeCompare(b.name);
                });

                sortedTeamPlayers.forEach(player => {
                    const listItem = document.createElement('li');
                    listItem.className = 'player';

                    if ((this.teamMode === 'adminTeams' || this.teamMode === 'randomTeams')) {
                        listItem.draggable = true;
                        listItem.dataset.playerId = player.id;

                        if (!player.isAdmin) {
                            listItem.addEventListener('dragstart', (e) => {
                                e.dataTransfer.setData('playerId', player.id);
                                listItem.classList.add('dragging');
                            });

                            listItem.addEventListener('dragend', () => {
                                listItem.classList.remove('dragging');
                            });
                        } else {
                            listItem.addEventListener('dragstart', (e) => {
                                e.dataTransfer.setData('playerId', 'admin');
                                listItem.classList.add('dragging');
                            });

                            listItem.addEventListener('dragend', () => {
                                listItem.classList.remove('dragging');
                            });
                        }
                    }

                    let statusIcon = '';
                    if (player.submittedStatements) {
                        statusIcon = '<span class="status-icon submitted">✓</span>';
                    } else {
                        statusIcon = '<span class="status-icon typing">...</span>';
                    }

                    const adminIcon = player.isAdmin ? '<span class="admin-icon">👑</span> ' : '';

                    listItem.innerHTML = `
                        <span class="player-name">${adminIcon}${player.name}</span>
                        ${statusIcon}
                    `;

                    teamList.appendChild(listItem);
                });

                connectedPlayers.appendChild(teamList);
            });
        } else {
            const playerList = document.createElement('ul');
            playerList.className = 'players-list';

            let playersArray = Array.from(this.players.entries())
                .map(([id, player]) => ({id, ...player}));

            if (this.adminName) {
                playersArray.push({
                    id: 'admin',
                    name: this.adminName + ' (Admin)',
                    isAdmin: true,
                    ready: true,
                    submittedStatements: true
                });
            }

            playersArray.sort((a, b) => {
                if (a.isAdmin) return -1;
                if (b.isAdmin) return 1;
                return a.name.localeCompare(b.name);
            });

            playersArray.forEach(player => {
                const listItem = document.createElement('li');
                listItem.className = 'player';

                let statusIcon = '';
                if (player.submittedStatements) {
                    statusIcon = '<span class="status-icon submitted">✓</span>';
                } else {
                    statusIcon = '<span class="status-icon typing">...</span>';
                }

                const adminIcon = player.isAdmin ? '<span class="admin-icon">👑</span> ' : '';

                listItem.innerHTML = `
                    <span class="player-name">${adminIcon}${player.name}</span>
                    ${statusIcon}
                `;

                playerList.appendChild(listItem);
            });

            connectedPlayers.appendChild(playerList);
        }

        this.updateDrawingPlayersList();

        if (this.teamMode === 'adminTeams' || this.teamMode === 'randomTeams') {
            this.setupTeamDragAndDrop();
        }

        this.validateGameCanStart();
        this.updateStartButton();
    }

    reassignPlayerTeam(playerId, targetTeamId) {
        if (!playerId || !targetTeamId) return;

        const teamIdNumber = parseInt(targetTeamId);

        if (playerId === 'admin') {
            this.adminTeamId = teamIdNumber;
            this.updatePlayersList();

            if (this.ws) {
                const message = {
                    type: 'admin_team_update',
                    teamId: teamIdNumber
                };
                this.ws.send(JSON.stringify(message));
            }
            return;
        }

        if (this.ws) {
            const message = {
                type: 'assign_player_to_team',
                playerId: playerId,
                teamId: teamIdNumber
            };
            this.ws.send(JSON.stringify(message));
        }
    }

    updateDrawingPlayersList() {
        const playersList = document.getElementById('playersList');
        if (!playersList) return;

        playersList.innerHTML = '';

        const playersArray = Array.from(this.players.entries()).map(([playerId, player]) => {
            return {
                id: playerId,
                name: player.name || 'Player',
                color: player.color || '#000000'
            };
        });

        playersArray.push({
            id: 'admin',
            name: this.adminName ? `${this.adminName} (You)` : 'Admin (You)',
            color: '#000000',
            isAdmin: true
        });

        playersArray.sort((a, b) => {
            if (a.isAdmin) return -1;
            if (b.isAdmin) return 1;
            return a.name.localeCompare(b.name);
        });

        playersArray.forEach(player => {
            const playerItem = document.createElement('div');
            playerItem.className = 'player-item';
            playerItem.id = `player-item-${player.id}`;

            const colorIndicator = document.createElement('div');
            colorIndicator.className = 'player-color-indicator';
            colorIndicator.style.backgroundColor = player.color;

            const nameDisplay = document.createElement('div');
            nameDisplay.className = 'player-name-display';
            nameDisplay.textContent = player.name;

            if (player.isAdmin) {
                colorIndicator.innerHTML = '👑';
                colorIndicator.style.display = 'flex';
                colorIndicator.style.alignItems = 'center';
                colorIndicator.style.justifyContent = 'center';
                colorIndicator.style.fontSize = '14px';
                colorIndicator.style.backgroundColor = 'rgba(255, 215, 0, 0.2)';
                colorIndicator.style.color = '#FFD700';
                playerItem.style.borderLeft = '2px solid #FFD700';
            }

            playerItem.appendChild(colorIndicator);
            playerItem.appendChild(nameDisplay);
            playersList.appendChild(playerItem);
        });

        this.validateGameCanStart();
    }

    handlePlayerJoined(data) {
        DEBUG.log('Player joined:', data);
        if (!data.playerId || !data.name) {
            DEBUG.log('Invalid player data received:', data);
            return;
        }

        const player = {
            id: data.playerId,
            color: data.color,
            name: data.name
        };
        this.players.set(data.playerId, player);

        this.updatePlayersList();

        DEBUG.log('Current players:', Array.from(this.players.entries()));
    }

    handlePlayerLeft(data) {
        DEBUG.log('Player left:', data);
        if (!data.playerId) {
            DEBUG.log('Invalid player left data:', data);
            return;
        }

        if (this.players.has(data.playerId)) {
            const player = this.players.get(data.playerId);
            this.players.delete(data.playerId);
            DEBUG.log(`Player ${data.playerId} removed from list`);

            if (this.teamMode !== 'allVsAll' && this.teams) {
                if (player.teamId && this.teams[player.teamId]) {
                    const team = this.teams[player.teamId];
                    const index = team.indexOf(data.playerId);
                    if (index > -1) {
                        team.splice(index, 1);
                    }
                }
            }
        } else {
            DEBUG.log(`Player ${data.playerId} not found in list`);
        }

        this.updatePlayersList();

        DEBUG.log('Remaining players:', Array.from(this.players.entries()));
    }

    handlePlayerInput(data) {
        if (!this.paintSessionStarted) return;

        DEBUG.log('Received paint input:', data);
    }

    updateCopyLink() {
        const copyLinkInput = document.getElementById('copyLinkInput');
        if (copyLinkInput) {
            const currentUrl = window.location.href;
            const baseUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/'));
            copyLinkInput.value = `${baseUrl}/player.html?code=${this.gameCode}`;
        }
    }

    generateQRCode() {
        if (typeof QRCode === 'undefined') {
            DEBUG.log('QRCode library not loaded!');
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
            script.onload = () => {
                DEBUG.log('QRCode library loaded, retrying...');
                this.generateQRCode();
            };
            document.head.appendChild(script);
            return;
        }

        const qrContainer = document.getElementById('qrcode');
        if (!qrContainer) {
            DEBUG.log('QR code container not found!');
            return;
        }
        qrContainer.innerHTML = '';

        const currentUrl = window.location.href;
        const baseUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/'));
        const playerURL = `${baseUrl}/player.html?code=${this.gameCode}`;

        DEBUG.log('Generating QR for URL:', playerURL);

        try {
            new QRCode(qrContainer, {
                text: playerURL,
                width: 256,
                height: 256,
                colorDark : "#000000",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.H
            });
            DEBUG.log('QR code generated successfully');



            const copyButton = document.getElementById('copyButton');
            const buttonSpan = copyButton ? copyButton.querySelector('span') : null;
            let originalButtonText = '';
            let isHoveringQrCode = false;

            if (buttonSpan) {

                originalButtonText = buttonSpan.textContent;


                const qrCodeElement = document.getElementById('qrcode');
                if (qrCodeElement) {
                    qrCodeElement.addEventListener('mouseenter', () => {
                        isHoveringQrCode = true;
                        buttonSpan.textContent = 'Click to Copy';
                    });

                    qrCodeElement.addEventListener('mouseleave', () => {
                        isHoveringQrCode = false;
                        buttonSpan.textContent = originalButtonText;
                    });
                }


                copyButton.addEventListener('mouseenter', () => {

                    if (!isHoveringQrCode) {
                        buttonSpan.textContent = originalButtonText;
                    }
                });
            }


            qrContainer.parentElement.onclick = () => {
                if (copyButton) {
                    copyButton.click();
                }
            };

        } catch (error) {
            DEBUG.log('Error generating QR code:', error);
        }
    }

    resetGameScreen() {
        this.paintSessionStarted = false;

        const qrBoard = document.querySelector('.qr-board');
        if (qrBoard) qrBoard.classList.remove('hidden');
        this.updateStartButton();
    }

    handlePlayAgain() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.resetGameScreen();
            this.ws.send(JSON.stringify({
                type: 'play_again'
            }));
        }
    }

    resetGame() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'reset_game'
            }));

            this.gamePhase = 'setup';
            this.gameStarted = false;
            this.readyPlayers = new Set();
            this.currentRound = 0;

            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }

            if (this.countdownInterval) {
                clearInterval(this.countdownInterval);
                this.countdownInterval = null;
            }

            const timerElement = document.getElementById('countdownTimer');
            if (timerElement) {
                timerElement.style.visibility = '';
                timerElement.style.display = '';
                timerElement.classList.remove('active', 'timer-state-green', 'timer-state-orange', 'timer-state-red');

                const timerProgress = timerElement.querySelector('.timer-circle-progress');
                if (timerProgress) {
                    timerProgress.style.strokeDashoffset = '';
                    timerProgress.style.stroke = '';
                }

                const timerDisplay = timerElement.querySelector('.timer-display');
                if (timerDisplay) {
                    timerDisplay.textContent = '--';
                    timerDisplay.style.color = '';
                }
            }

            const leftColumn = document.querySelector('.left-column');
            if (leftColumn) {
                leftColumn.classList.remove('guessing-phase');
                const statementsContainer = leftColumn.querySelector('.statements-container');
                if (statementsContainer) statementsContainer.innerHTML = '';
            }

            this.broadcastGameStatusMessage('Game has been reset. Ready to start a new game.', true);

            this.clearDynamicStatementsFromStorage();

            this.updateUIForGamePhase();
            this.updateStartButton();

            this.updatePlayersList();

            DEBUG.log('Game reset completed');
        }
    }

    endRound() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'end_round'
            }));

            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }

            DEBUG.log('Round ended');
        }
    }

    handlePlayAgain() {
        this.resetGame();
        DEBUG.log('Play again requested');
    }

    updateInterfaceForGamePhase(phase) {
        if (phase) {
            this.gamePhase = phase;
        }

        DEBUG.log('Updating interface for game phase:', this.gamePhase);

        const setupSection = document.querySelector('.setup-section');
        const submissionSection = document.querySelector('.submission-section');
        const guessingSection = document.querySelector('.guessing-section');
        const resultsSection = document.querySelector('.results-section');

        if (setupSection) setupSection.classList.add('hidden');
        if (submissionSection) submissionSection.classList.add('hidden');
        if (guessingSection) guessingSection.classList.add('hidden');
        if (resultsSection) resultsSection.classList.add('hidden');

        switch (this.gamePhase) {
            case 'setup':
                if (setupSection) setupSection.classList.remove('hidden');
                break;
            case 'countdown':
                if (submissionSection) submissionSection.classList.remove('hidden');
                break;
            case 'submission':
                if (submissionSection) submissionSection.classList.remove('hidden');
                this.updatePlayerReadyStatus();
                break;
            case 'guessing':
                if (guessingSection) guessingSection.classList.remove('hidden');
                this.showCurrentPlayerStatements();
                break;
            case 'results':
                if (resultsSection) resultsSection.classList.remove('hidden');
                this.showGameResults();
                break;
        }

        this.updateUIForGamePhase();
    }

    showGameResults() {
        DEBUG.log('Showing game results');

        const resultsContainer = document.getElementById('results-container');
        if (!resultsContainer) return;

        resultsContainer.classList.remove('hidden');

        const scoreData = this.scores || { teams: [], players: [], bestGuessers: [], bestDeceivers: [] };
        const teamMode = this.teamMode || 'allVsAll';
        const isTeamGame = teamMode !== 'allVsAll';

        const teamScoresContainer = document.getElementById('team-scores-container');
        const teamScoresList = document.getElementById('team-scores-list');

        const playersList = document.getElementById('player-scores-list');
        const guessersList = document.getElementById('best-guessers-list');
        const deceiversList = document.getElementById('best-deceivers-list');

        let highestTeamScore = 0;
        let highestPlayerScore = 0;

        if (teamScoresContainer) {
            teamScoresContainer.classList.add('hidden');
        }

        if (isTeamGame && scoreData.teams && scoreData.teams.length > 0) {
            if (teamScoresContainer) {
                teamScoresContainer.classList.remove('hidden');
            }
            teamScoresList.innerHTML = '';

            highestTeamScore = Math.max(...scoreData.teams.map(team => team.score || 0));


            scoreData.teams.forEach(team => {
                if (team.players && team.players.length > 0) {
                    const scoreItem = document.createElement('div');
                    scoreItem.className = 'score-item';
                    if (team.score === highestTeamScore && team.score > 0) {
                        scoreItem.classList.add('winner');
                    }

                    const teamName = team.name || 'Team ' + team.id;

                    scoreItem.innerHTML = `
                        <div class="score-name">${teamName}</div>
                        <div class="score-value">${team.score || 0} points</div>
                    `;

                    teamScoresList.appendChild(scoreItem);
                }
            });
        } else {
            teamScoresContainer.classList.add('hidden');
        }

        if (playersList) {
            playersList.innerHTML = '';

            if (scoreData.players && scoreData.players.length > 0) {
                highestPlayerScore = Math.max(...scoreData.players.map(player => player.score || 0));

                scoreData.players.forEach(player => {

                    const scoreItem = document.createElement('div');
                    scoreItem.className = 'score-item';

                    if (player.score === highestPlayerScore && player.score > 0) {
                        scoreItem.classList.add('winner');
                    }

                    let teamInfo = '';
                    if (isTeamGame && player.teamName) {
                        teamInfo = ` <span class="team-badge">${player.teamName}</span>`;
                    }

                    scoreItem.innerHTML = `
                        <div class="score-name">${player.name}${teamInfo}</div>
                        <div class="score-value">${player.score || 0} points</div>
                    `;

                    playersList.appendChild(scoreItem);
                });
            } else {
                playersList.innerHTML = '<div class="no-scores">No player scores available</div>';
            }
        }

        if (guessersList) {
            guessersList.innerHTML = '';

            if (scoreData.bestGuessers && scoreData.bestGuessers.length > 0) {
                scoreData.bestGuessers.forEach(player => {
                    const scoreItem = document.createElement('div');
                    scoreItem.className = 'score-item';

                    const correctLies = player.lieCorrectCount || 0;
                    const playerGuesses = player.totalGuesses || 0;

                    scoreItem.innerHTML = `
                        <div class="score-name">${player.name}</div>
                        <div class="score-details">
                            <span class="success-rate">${correctLies} lies detected</span>
                            <span class="details">(${correctLies}/${playerGuesses})</span>
                        </div>
                    `;

                    guessersList.appendChild(scoreItem);
                });
            } else {
                guessersList.innerHTML = '<div class="no-scores">Not enough guesses to rank</div>';
            }
        }

        if (deceiversList) {
            deceiversList.innerHTML = '';

            const effectiveDeceivers = scoreData.bestDeceivers ?
                scoreData.bestDeceivers.filter(player => (player.deceptionRate || 0) > 0) : [];

            if (effectiveDeceivers.length > 0) {
                effectiveDeceivers.forEach(player => {
                    const scoreItem = document.createElement('div');
                    scoreItem.className = 'score-item';

                    const deceptionRate = Math.round((player.deceptionRate || 0) * 100);

                    scoreItem.innerHTML = `
                        <div class="score-name">${player.name}</div>
                        <div class="score-value">${deceptionRate}% fooled others</div>
                    `;

                    deceiversList.appendChild(scoreItem);
                });
            } else {
                deceiversList.innerHTML = '<div class="no-scores">No successful deceptions</div>';
            }
        }

        const summaryText = document.getElementById('results-summary-text');
        if (summaryText) {
            let summaryLines = ['Game Complete!'];

            if (isTeamGame && scoreData.teams && scoreData.teams.length > 0) {
                const winningTeams = scoreData.teams.filter(team =>
                    team.score === highestTeamScore && team.score > 0);

                if (winningTeams.length > 0) {
                    if (winningTeams.length === 1) {
                        summaryLines.push(`${winningTeams[0].name || 'Team ' + winningTeams[0].id} wins with ${winningTeams[0].score} points!`);
                    } else {
                        const teamNames = winningTeams.map(team => team.name || 'Team ' + team.id).join(' and ');
                        summaryLines.push(`It's a tie between ${teamNames} with ${highestTeamScore} points each!`);
                    }
                }
            } else if (scoreData.players && scoreData.players.length > 0) {
                const playerScores = scoreData.players;
                if (playerScores.length > 0) {
                    const highestScore = Math.max(...playerScores.map(p => p.score || 0));
                    const winningPlayers = playerScores.filter(p =>
                        p.score === highestScore && p.score > 0);

                    if (winningPlayers.length > 0) {
                        if (winningPlayers.length === 1) {
                            summaryLines.push(`${winningPlayers[0].name} wins with ${winningPlayers[0].score} points!`);
                        } else {
                            const playerNames = winningPlayers.map(p => p.name).join(' and ');
                            summaryLines.push(`It's a tie between ${playerNames} with ${highestScore} points each!`);
                        }
                    }
                }
            }

            if (scoreData.bestGuessers && scoreData.bestGuessers.length > 0 &&
                scoreData.bestGuessers[0].lieSuccessRate > 0.5) {
                const bestGuesser = scoreData.bestGuessers[0];
                const lieSuccessRate = Math.round(bestGuesser.lieSuccessRate * 100);
                summaryLines.push(`${bestGuesser.name} was the best lie detector with ${lieSuccessRate}% accuracy!`);
            }

            if (scoreData.bestDeceivers && scoreData.bestDeceivers.length > 0 &&
                scoreData.bestDeceivers[0].deceptionRate > 0.5) {
                const bestDeceiver = scoreData.bestDeceivers[0];
                const deceptionRate = Math.round(bestDeceiver.deceptionRate * 100);
                summaryLines.push(`${bestDeceiver.name} fooled ${deceptionRate}% of guessers with their lie!`);
            }

            if (summaryLines.length === 1) {
                summaryText.textContent = 'Game Complete! No scores recorded yet.';
            } else {
                summaryText.textContent = summaryLines.join(' ');
            }
        }
    }

    updateGameProgressBar(data) {
        const progressBar = document.getElementById('gameProgressBar');
        const currentRoundNum = document.getElementById('currentRoundNum');
        const totalRoundsNum = document.getElementById('totalRoundsNum');

        if (!progressBar || !currentRoundNum || !totalRoundsNum || !data.currentSetIndex || !data.totalSets) return;

        const currentSetIndex = data.currentSetIndex;
        const totalSets = data.totalSets;

        let progressPercentage = 0;

        if (this.gamePhase === 'setup') {
            progressPercentage = 0;
        } else if (this.gamePhase === 'gameEnd') {
            progressPercentage = 100;
        } else {
            progressPercentage = (currentSetIndex / totalSets) * 100;
        }

        progressBar.style.width = `${progressPercentage}%`;
        progressBar.style.background = 'linear-gradient(to right, #6db3f2, #4a8ed4)';

        currentRoundNum.textContent = currentSetIndex;
        totalRoundsNum.textContent = totalSets;
    }

    handleGameCountdown(seconds) {
        DEBUG.log('Starting game countdown for', seconds, 'seconds');

        const countdownOverlay = document.getElementById('countdownOverlay');
        const countdownNumber = countdownOverlay?.querySelector('.countdown-number');

        if (!countdownOverlay || !countdownNumber) {
            DEBUG.log('Countdown overlay elements not found');
            return;
        }

        countdownOverlay.classList.add('visible');

        let count = seconds;
        countdownNumber.textContent = count;

        const countdownInterval = setInterval(() => {
            count--;

            if (count <= 0) {
                clearInterval(countdownInterval);
                countdownOverlay.classList.remove('visible');

                this.progressToNextGamePhase();
            } else {
                countdownNumber.textContent = count;
            }
        }, 1000);
    }

    updateGameTimerDisplay(seconds) {
        DEBUG.log('Updating game timer display with', seconds, 'seconds');

        const timerDisplay = document.querySelector('.timer-display');
        if (!timerDisplay) {
            DEBUG.log('Timer display element not found');
            return;
        }

        timerDisplay.textContent = seconds;

        const timerCircle = document.querySelector('.timer-circle-progress');
        if (timerCircle) {
            timerCircle.style.animation = 'none';
            void timerCircle.offsetWidth;

            timerCircle.style.animation = `countdown-circle ${seconds}s linear forwards`;
        }
    }

    progressToNextGamePhase() {
        DEBUG.log('Progressing from current game phase:', this.gamePhase);

        switch (this.gamePhase) {
            case 'setup':
                this.updateInterfaceForGamePhase('submission');

                this.ws.send(JSON.stringify({
                    type: 'phase_change',
                    phase: 'submission'
                }));
                break;

            case 'submission':
                const allReady = Array.from(this.players.values()).every(player => player.ready);

                if (!allReady) {
                    this.ws.send(JSON.stringify({
                        type: 'prompt_submissions'
                    }));

                    this.updateGameTimerDisplay(10);
                    setTimeout(() => {
                        this.proceedToGuessing();
                    }, 10000);
                } else {
                    this.proceedToGuessing();
                }
                break;

            case 'guessing':
                if (this.currentPlayerIndex < this.orderedPlayerIds.length - 1) {
                    this.currentPlayerIndex++;
                    this.showCurrentPlayerStatements();

                    const guessTime = this.gameSettings?.guessTime || 10;
                    this.updateGameTimerDisplay(guessTime);

                    this.handleGameCountdown(guessTime);
                } else {
                    this.updateInterfaceForGamePhase('results');

                    this.ws.send(JSON.stringify({
                        type: 'phase_change',
                        phase: 'results'
                    }));
                }
                break;

            case 'results':
                const playAgainBtn = document.getElementById('playAgainBtn');
                if (playAgainBtn) {
                    playAgainBtn.classList.remove('hidden');
                }
                break;
        }
    }

    proceedToGuessing() {
        this.updateInterfaceForGamePhase('guessing');

        this.currentPlayerIndex = 0;
        this.orderedPlayerIds = Array.from(this.players.keys());

        this.showCurrentPlayerStatements();

        this.ws.send(JSON.stringify({
            type: 'phase_change',
            phase: 'guessing'
        }));
    }

    updateStatementsDisplay() {
        DEBUG.log('Updating statements display');

        const statementsContainer = document.getElementById('statements-container');
        if (!statementsContainer) return;

        statementsContainer.innerHTML = '';

        if (this.statements.length === 0) {
            statementsContainer.innerHTML = '<p class="no-statements">No statements submitted yet</p>';
            return;
        }

        this.statements.forEach(statement => {
            const statementCard = document.createElement('div');
            statementCard.className = 'statement-card';

            const header = document.createElement('div');
            header.className = 'statement-header';
            header.innerHTML = `<h3>${statement.name}</h3>`;

            const statementsList = document.createElement('div');
            statementsList.className = 'statements-list';

            statement.truths.forEach((truth, index) => {
                const truthItem = document.createElement('div');
                truthItem.className = 'statement truth';
                truthItem.innerHTML = `<span class="number">${index + 1}</span> <p>${truth}</p>`;
                statementsList.appendChild(truthItem);
            });

            const lieItem = document.createElement('div');
            lieItem.className = 'statement lie';
            lieItem.innerHTML = `<span class="number">${statement.truths.length + 1}</span> <p>${statement.lie}</p>`;
            statementsList.appendChild(lieItem);

            statementCard.appendChild(header);
            statementCard.appendChild(statementsList);

            statementsContainer.appendChild(statementCard);
        });
    }

    setupTeamDragAndDrop() {
        const playerItems = document.querySelectorAll('.connected-players .player');
        const teamLists = document.querySelectorAll('.connected-players .team-players');

        let touchDragElement = null;
        let touchDragPlayerId = null;
        let touchStartX = 0;
        let touchStartY = 0;

        playerItems.forEach(item => {
            item.draggable = true;
            item.style.cursor = 'grab';

            item.addEventListener('dragstart', (e) => {
                const playerId = item.dataset.playerId;
                e.dataTransfer.setData('text/plain', playerId);

                teamLists.forEach(list => {
                    list.classList.add('potential-target');
                });
            });

            item.addEventListener('dragend', () => {
                teamLists.forEach(list => {
                    list.classList.remove('potential-target');
                });
            });

            item.addEventListener('touchstart', (e) => {
                e.preventDefault();

                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;

                touchDragElement = item;
                touchDragPlayerId = item.dataset.playerId;

                item.classList.add('touch-dragging');

                teamLists.forEach(list => {
                    list.classList.add('potential-target');
                });
            }, { passive: false });

            item.addEventListener('touchmove', (e) => {
                if (!touchDragElement) return;

                e.preventDefault();

                const touchX = e.touches[0].clientX;
                const touchY = e.touches[0].clientY;

                const elemBelow = document.elementFromPoint(touchX, touchY);

                teamLists.forEach(list => {
                    if (list === elemBelow || list.contains(elemBelow)) {
                        list.classList.add('drag-over');
                    } else {
                        list.classList.remove('drag-over');
                    }
                });
            }, { passive: false });

            item.addEventListener('touchend', (e) => {
                if (!touchDragElement) return;

                e.preventDefault();

                const touchX = e.changedTouches[0].clientX;
                const touchY = e.changedTouches[0].clientY;

                const elemBelow = document.elementFromPoint(touchX, touchY);

                touchDragElement.classList.remove('touch-dragging');
                teamLists.forEach(list => {
                    list.classList.remove('drag-over');
                    list.classList.remove('potential-target');
                });

                teamLists.forEach(list => {
                    if (list === elemBelow || list.contains(elemBelow)) {
                        const currentTeamId = list.dataset.teamId;
                        if (touchDragPlayerId && currentTeamId) {
                            this.reassignPlayerTeam(touchDragPlayerId, currentTeamId);
                        }
                    }
                });

                touchDragElement = null;
                touchDragPlayerId = null;
            }, { passive: false });

            item.addEventListener('touchcancel', () => {
                if (!touchDragElement) return;

                touchDragElement.classList.remove('touch-dragging');
                teamLists.forEach(list => {
                    list.classList.remove('drag-over');
                    list.classList.remove('potential-target');
                });

                touchDragElement = null;
                touchDragPlayerId = null;
            });
        });

        teamLists.forEach(list => {
            let teamId = list.dataset.teamId;

            if (!teamId && list.parentElement && list.parentElement.dataset.teamId) {
                teamId = list.parentElement.dataset.teamId;
            }

            if (teamId && !list.dataset.teamId) {
                list.dataset.teamId = teamId;
            }

            list.addEventListener('dragover', (e) => {
                e.preventDefault();
                list.classList.add('drag-over');
            });

            list.addEventListener('dragleave', () => {
                list.classList.remove('drag-over');
            });

            list.addEventListener('drop', (e) => {
                e.preventDefault();
                list.classList.remove('drag-over');

                const playerId = e.dataTransfer.getData('text/plain');

                const currentTeamId = list.dataset.teamId || teamId;

                if (playerId && currentTeamId) {
                    this.reassignPlayerTeam(playerId, currentTeamId);
                } else {
                    DEBUG.log('Missing playerId or teamId for team reassignment', { playerId, teamId: currentTeamId });
                }
            });
        });
    }

    updatePlayerReadyStatus() {
        DEBUG.log('Updating player ready status');
        const playerItems = document.querySelectorAll('.player-item');

        let readyCount = 0;
        let totalPlayers = this.players.size;

        playerItems.forEach(item => {
            const playerId = item.dataset.playerId;
            const player = this.players.get(playerId);

            if (player && player.ready) {
                item.classList.add('ready');
                readyCount++;

                let readyIcon = item.querySelector('.ready-indicator');
                if (!readyIcon) {
                    readyIcon = document.createElement('span');
                    readyIcon.className = 'ready-indicator';
                    readyIcon.innerHTML = '<i class="fas fa-check-circle"></i>';
                    item.appendChild(readyIcon);
                }
            } else {
                item.classList.remove('ready');

                const readyIcon = item.querySelector('.ready-indicator');
                if (readyIcon) {
                    item.removeChild(readyIcon);
                }

                if (this.gamePhase === 'submission') {
                    item.classList.add('waiting-animation');
                } else {
                    item.classList.remove('waiting-animation');
                }
            }
        });

        const readyCountElement = document.getElementById('ready-count');
        const readyProgressBar = document.getElementById('ready-progress');
        const playerCountBadge = document.getElementById('players-count-badge');

        if (readyCountElement) {
            readyCountElement.textContent = `${readyCount} / ${totalPlayers}`;
        }

        const percentage = totalPlayers > 0 ? (readyCount / totalPlayers) * 100 : 0;

        if (readyProgressBar) {
            readyProgressBar.style.width = `${percentage}%`;

            if (percentage >= 100) {
                readyProgressBar.classList.add('complete');
            } else if (percentage >= 70) {
                readyProgressBar.classList.add('good-progress');
                readyProgressBar.classList.remove('complete');
            } else {
                readyProgressBar.classList.remove('good-progress', 'complete');
            }
        }

        if (playerCountBadge) {
            playerCountBadge.textContent = `${readyCount}/${totalPlayers}`;
        }

        this.updateStartGameButtonText(readyCount, totalPlayers);
    }

    updateStartGameButtonText(readyCount, totalPlayers, customText = null) {
        const startGameBtn = document.getElementById('start-game-button');
        if (!startGameBtn) return;

        if (customText) {
            startGameBtn.innerHTML = customText;
            startGameBtn.classList.remove('all-players-ready');
            return;
        }

        if (!this.gameStarted) {
            const originalText = startGameBtn.dataset.originalText || "Start Game";

            if (!startGameBtn.dataset.originalText) {
                startGameBtn.dataset.originalText = originalText;
            }

            startGameBtn.innerHTML = `${originalText} <span class="player-count-badge">${readyCount}/${totalPlayers}</span>`;

            if (readyCount === totalPlayers && totalPlayers > 0) {
                startGameBtn.classList.add('all-players-ready');
            } else {
                startGameBtn.classList.remove('all-players-ready');
            }

            this.validateGameCanStart();
        }
    }

    updateGuessDisplay(guessingPlayerId, targetPlayerId, statementIndex) {
        DEBUG.log(`Updating guess display for player ${guessingPlayerId} guessing on ${targetPlayerId}`);

        const guessingPlayer = this.players.get(guessingPlayerId);
        const targetPlayer = this.players.get(targetPlayerId);

        if (!guessingPlayer || !targetPlayer) return;

        let guessContainer = document.querySelector(`.guess-list[data-target-player="${targetPlayerId}"]`);

        if (!guessContainer) {
            guessContainer = document.createElement('div');
            guessContainer.className = 'guess-list';
            guessContainer.dataset.targetPlayer = targetPlayerId;

            const guessesSection = document.querySelector('.guesses-section');
            if (guessesSection) guessesSection.appendChild(guessContainer);
        }

        const guessItem = document.createElement('div');
        guessItem.className = 'guess-item';
        guessItem.dataset.guessingPlayer = guessingPlayerId;

        guessItem.innerHTML = `
            <span class="player-name" style="color: ${guessingPlayer.color}">${guessingPlayer.name}</span>
            guessed that statement <span class="statement-number">${statementIndex + 1}</span> is the lie.
        `;

        guessContainer.appendChild(guessItem);

        const playerItem = document.querySelector(`.player-item[data-player-id="${guessingPlayerId}"]`);
        if (playerItem) {
            const guessCountBadge = playerItem.querySelector('.guess-count') || document.createElement('span');
            if (!playerItem.querySelector('.guess-count')) {
                guessCountBadge.className = 'guess-count';
                playerItem.appendChild(guessCountBadge);
            }

            const guessCount = guessingPlayer.guesses ? guessingPlayer.guesses.length : 1;
            guessCountBadge.textContent = guessCount;
        }
    }

    advanceToNextPlayerOrResults() {
        DEBUG.log('Advancing to next player or results');

        if (this.currentPlayerIndex >= this.playerOrder.length - 1) {
            DEBUG.log('All players have been guessed on, moving to results phase');
            this.gamePhase = 'results';
            this.updateInterfaceForGamePhase('results');
            return;
        }

        this.currentPlayerIndex++;

        this.players.forEach(player => {
            player.guessedCurrentPlayer = false;
        });

        this.showCurrentPlayerStatements();

        if (this.autoAdvance) {
            this.startTimer();
        }

        if (this.ws && this.isConnected) {
            this.ws.send(JSON.stringify({
                type: 'next_player',
                currentPlayerIndex: this.currentPlayerIndex
            }));
        }
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    showCurrentPlayerStatements() {
        DEBUG.log('Showing current player statements for round:', this.currentRound);

        const currentPlayer = this.getPlayerForRound(this.currentRound);
        if (!currentPlayer) return;

        const statementDisplay = document.getElementById('current-statements');
        if (!statementDisplay) return;

        statementDisplay.innerHTML = '';

        const header = document.createElement('h3');
        header.textContent = `${currentPlayer.name}'s Statements`;
        statementDisplay.appendChild(header);

        const statementsList = document.createElement('ul');
        statementsList.className = 'guessing-statements';

        const allStatements = [...currentPlayer.truths, currentPlayer.lie];
        allStatements.sort(() => Math.random() - 0.5);

        allStatements.forEach((statement, index) => {
            const statementItem = document.createElement('li');
            statementItem.innerHTML = `
                <div class="statement-number">${index + 1}</div>
                <div class="statement-text">${statement}</div>
                <div class="statement-vote">
                    <button class="vote-truth">Truth</button>
                    <button class="vote-lie">Lie</button>
                </div>
            `;
            statementsList.appendChild(statementItem);
        });

        statementDisplay.appendChild(statementsList);
    }

    getPlayerForRound(roundIndex) {
        const playerIds = Array.from(this.statements.map(s => s.playerId));
        if (playerIds.length === 0) return null;

        const playerIndex = roundIndex % playerIds.length;
        return this.statements[playerIndex];
    }

    updatePlayerTeam(playerId, teamId) {
        DEBUG.log(`Updating player ${playerId} to team ${teamId}`);

        const player = this.players.get(playerId);
        if (!player) return;

        player.team = teamId;

        if (this.ws && this.isConnected) {
            this.ws.send(JSON.stringify({
                type: 'update_team',
                playerId,
                teamId
            }));
        }

        this.updatePlayersList();
    }

    updateCurrentAdminScore(scores) {
        if (!scores) return;

        const currentScoreDiv = document.querySelector('.current-score');
        if (!currentScoreDiv) return;

        const adminScoreObj = scores && scores.players ?
            scores.players.find(p => p.id === 'admin') : null;

        let teamScoreObj = null;
        if (this.adminTeamId && scores && scores.teams) {
            teamScoreObj = scores.teams.find(t => String(t.id) === String(this.adminTeamId));
        }

        let html = '';

        if (adminScoreObj) {
            html += `<div class="player-score">Admin score: <span class="score-value">${adminScoreObj.score || 0}</span></div>`;
        }

        if (teamScoreObj && this.teamMode !== 'allVsAll') {
            html += `<div class="team-score">${teamScoreObj.name || 'Team'}: <span class="score-value">${teamScoreObj.score || 0}</span></div>`;
        }

        currentScoreDiv.innerHTML = html;
    }
}

let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            DEBUG.log('WakeLock active');
        }
    } catch (err) {
        DEBUG.log(`WakeLock error: ${err.name}, ${err.message}`);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        requestWakeLock();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');

    if (!code) {
        GameAdmin.showError('No API code found. Please include a valid API code in the URL using ?code=YOUR_API_CODE');
        return;
    }

    game = new GameAdmin();
    game.apiCode = code;

    requestWakeLock();
});
