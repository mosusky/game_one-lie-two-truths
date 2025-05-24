window.DEBUG = {
    enabled: null,
    isLocal: () => (window.location.port || '80') === '777',
    log: function (...args) {
        if (this.enabled === null) {
            if (this.isLocal()) {
                console.log(...args);
            }
        } else if (this.enabled) {
            console.log(...args);
        }
    },
    enable: function () {
        this.enabled = true;
        console.log('Debug mode explicitly enabled');
    },
    deactivate: function () {
        this.enabled = false;
        console.log('Debug mode explicitly deactivated');
    },
    reset: function () {
        this.enabled = null;
        console.log('Debug mode reset to default behavior');
    },
    on: function () { this.enable(); },
    off: function () { this.deactivate(); }
};

function normalizeImagePath(imagePath) {
    let filename = imagePath;
    if (imagePath.includes('/')) {
        filename = imagePath.split('/').pop();
    }

    return `images/draw/${filename}`;
}

class PlayerController {
    constructor() {
        this.ws = null;
        this.gameCode = null;
        this.name = null;
        this.playerId = null;
        this.isConnected = false;
        this.validateTextareasTimeout = null;
        this.gameStarted = false;
        this.guessingPhase = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 9999999999;
        this.reconnectInterval = null;
        this.adminName = 'Admin';
        this.connectedPlayers = new Map();
        this.teamId = null;
        this.teamName = null;
        this.roundsCount = 1;

        this.truth1 = '';
        this.truth2 = '';
        this.lie = '';
        this.statementsSubmitted = false;
        this.currentRound = 0;
        this.currentPlayerBeingGuessed = null;
        this.myGuesses = new Map();
        this.score = 0;

        const submitStatementsBtn = document.getElementById('submitStatements');
        if (submitStatementsBtn) {
            submitStatementsBtn.classList.add('inactive');
            submitStatementsBtn.addEventListener('click', () => this.submitStatements());
        }

        const textareas = ['playerTruth1', 'playerTruth2', 'playerLie'];
        textareas.forEach(id => {
            const textarea = document.getElementById(id);
            if (textarea) {
                textarea.addEventListener('input', () => this.validateStatementTextareas());
            }
        });


        this.getGameCodeFromUrl();

        this.initializePlayerName();
        this.initializePlayersList();

        const storedPlayerId = localStorage.getItem('truths_and_lies_player_id');
        const storedPlayerName = localStorage.getItem('truths_and_lies_player_name');
        const storedGameCode = localStorage.getItem('truths_and_lies_game_code');

        DEBUG.log('Constructor - Stored data:', {
            playerId: storedPlayerId,
            name: storedPlayerName,
            gameCode: this.gameCode || storedGameCode
        });

        if (storedPlayerId && storedPlayerName && (this.gameCode || storedGameCode)) {
            DEBUG.log('Found stored player data, attempting reconnection...');
            this.name = storedPlayerName;
            this.playerId = storedPlayerId;
            if (!this.gameCode && storedGameCode) {
                this.gameCode = storedGameCode;
            }

            const playerNameInput = document.getElementById('playerName');
            if (playerNameInput) {
                playerNameInput.value = this.name;
            }

            document.getElementById('joinSection')?.classList.add('hidden');

            if (this.gameStarted && this.guessingPhase) {
                document.getElementById('guessingScreen')?.classList.remove('hidden');
                document.getElementById('waitingScreen')?.classList.add('hidden');
                document.getElementById('statementScreen')?.classList.add('hidden');
            } else if (this.gameStarted) {
                document.getElementById('statementScreen')?.classList.remove('hidden');
                document.getElementById('waitingScreen')?.classList.add('hidden');
                document.getElementById('guessingScreen')?.classList.add('hidden');
            } else {
                document.getElementById('waitingScreen')?.classList.remove('hidden');
                document.getElementById('statementScreen')?.classList.add('hidden');
                document.getElementById('guessingScreen')?.classList.add('hidden');
            }

            this.connectToGame();
        } else {
            DEBUG.log('No complete stored data found, showing join screen');
            document.getElementById('joinSection')?.classList.remove('hidden');
            document.getElementById('waitingScreen')?.classList.add('hidden');
            document.getElementById('statementScreen')?.classList.add('hidden');
            document.getElementById('guessingScreen')?.classList.add('hidden');
        }

        const exitButtons = document.querySelectorAll('.exit-game-btn');
        exitButtons.forEach(button => {
            button.addEventListener('click', () => {
                localStorage.removeItem('truths_and_lies_game_code');
                localStorage.removeItem('truths_and_lies_player_name');
                localStorage.removeItem('truths_and_lies_player_id');

                this.gameStarted = false;
                this.guessingPhase = false;
                this.isConnected = false;
                this.gameCode = null;
                this.name = null;
                this.playerId = null;
                this.teamId = null;
                this.teamName = null;
                this.truth1 = '';
                this.truth2 = '';
                this.lie = '';
                this.statementsSubmitted = false;
                this.currentRound = 0;
                this.currentPlayerBeingGuessed = null;
                this.myGuesses.clear();
                this.score = 0;

                if (this.reconnectInterval) {
                    clearInterval(this.reconnectInterval);
                    this.reconnectInterval = null;
                }
                this.reconnectAttempts = 0;

                const joinSection = document.getElementById('joinSection');
                const waitingScreen = document.getElementById('waitingScreen');
                const statementScreen = document.getElementById('statementScreen');
                const guessingScreen = document.getElementById('guessingScreen');
                const resultsScreen = document.getElementById('resultsScreen');

                if (joinSection) joinSection.classList.remove('hidden');
                if (waitingScreen) waitingScreen.classList.add('hidden');
                if (statementScreen) statementScreen.classList.add('hidden');
                if (guessingScreen) guessingScreen.classList.add('hidden');
                if (resultsScreen) resultsScreen.classList.add('hidden');

                const inputFields = [
                    document.getElementById('playerTruth1'),
                    document.getElementById('playerTruth2'),
                    document.getElementById('playerLie')
                ];

                inputFields.forEach(field => {
                    if (field) {
                        field.value = '';
                        field.removeAttribute('readonly');
                        field.classList.remove('inactive');
                    }
                });

                const submitBtn = document.getElementById('submitStatements');
                if (submitBtn) {
                    submitBtn.classList.remove('inactive', 'submitted');
                    submitBtn.textContent = 'Submit Statements';
                }

                const waitingMessage = document.getElementById('waitingMessage');
                if (waitingMessage) {
                    waitingMessage.classList.add('hidden');
                }

                if (this.ws) {
                    this.ws.close();
                    this.ws = null;
                }
            });
        });

    }

    showGameMessage(message, className = 'game-message') {
        const gameMessages = document.getElementById('gameMessages');
        if (gameMessages) {
            const msgElement = document.createElement('div');
            msgElement.className = className;
            msgElement.textContent = message;
            gameMessages.appendChild(msgElement);

            gameMessages.scrollTop = gameMessages.scrollHeight;

            setTimeout(() => {
                if (msgElement.parentNode === gameMessages) {
                    gameMessages.removeChild(msgElement);
                }
            }, 8000);
        }
    }

    updateTeamDisplay() {
        if (!this.teams || this.teams.length === 0) return;

        let myTeam = null;
        if (this.playerId) {
            myTeam = this.teams.find(team =>
                team.players && team.players.some(player => player.id === this.playerId));
        }

        if (myTeam) {
            this.teamId = myTeam.id;
            this.teamName = myTeam.name;
            localStorage.setItem('truths_and_lies_team_id', this.teamId);

            const teamDisplay = document.getElementById('playerTeam');
            if (teamDisplay) {
                teamDisplay.textContent = `Team: ${this.teamName}`;
                teamDisplay.classList.remove('hidden');
            }

            const waitingScreenTeam = document.getElementById('waitingScreenTeam');
            if (waitingScreenTeam) {
                waitingScreenTeam.textContent = `You're on Team: ${this.teamName}`;
                waitingScreenTeam.classList.remove('hidden');
            }

            this.showGameMessage(`You've been assigned to Team ${this.teamName}!`, 'game-message team-assignment');
        }
    }

    generateStatementInputs() {
        const container = document.getElementById('dynamicStatementInputs');
        if (!container) return;

        container.innerHTML = '';

        for (let i = 1; i <= this.roundsCount; i++) {
            if (this.roundsCount > 1) {
                const titleContainer = document.createElement('div');
                titleContainer.className = 'round-title-container';

                const roundTitle = document.createElement('h4');
                roundTitle.className = 'round-title';
                roundTitle.textContent = `Round ${i}`;
                titleContainer.appendChild(roundTitle);

                container.appendChild(titleContainer);
            }

            const setContainer = document.createElement('div');
            setContainer.className = 'statement-set';

            const truthDiv1 = document.createElement('div');
            truthDiv1.className = 'statement-input statement-input-truth';

            const truthLabel1 = document.createElement('label');
            const truthId1 = `playerTruth1_${i}`;
            truthLabel1.setAttribute('for', truthId1);
            truthLabel1.textContent = 'First truth';

            const truthTextarea1 = document.createElement('textarea');
            truthTextarea1.id = truthId1;
            truthTextarea1.placeholder = 'Enter a true statement about yourself';

            truthDiv1.appendChild(truthLabel1);
            truthDiv1.appendChild(truthTextarea1);
            setContainer.appendChild(truthDiv1);

            truthTextarea1.addEventListener('input', () => {
                this.validateStatementTextareas();
                this.savePlayerStatementsToStorage();
            });

            const truthDiv2 = document.createElement('div');
            truthDiv2.className = 'statement-input statement-input-truth';

            const truthLabel2 = document.createElement('label');
            const truthId2 = `playerTruth2_${i}`;
            truthLabel2.setAttribute('for', truthId2);
            truthLabel2.textContent = 'Second truth';

            const truthTextarea2 = document.createElement('textarea');
            truthTextarea2.id = truthId2;
            truthTextarea2.placeholder = 'Enter another true statement about yourself';

            truthDiv2.appendChild(truthLabel2);
            truthDiv2.appendChild(truthTextarea2);
            setContainer.appendChild(truthDiv2);

            truthTextarea2.addEventListener('input', () => {
                this.validateStatementTextareas();
                this.savePlayerStatementsToStorage();
            });

            const lieDiv = document.createElement('div');
            lieDiv.className = 'statement-input statement-input-lie';

            const lieLabel = document.createElement('label');
            const lieId = `playerLie_${i}`;
            lieLabel.setAttribute('for', lieId);
            lieLabel.textContent = 'One lie';

            const lieTextarea = document.createElement('textarea');
            lieTextarea.id = lieId;
            lieTextarea.placeholder = 'Enter a false statement about yourself';

            lieDiv.appendChild(lieLabel);
            lieDiv.appendChild(lieTextarea);
            setContainer.appendChild(lieDiv);

            lieTextarea.addEventListener('input', () => {
                this.validateStatementTextareas();
                this.savePlayerStatementsToStorage();
            });

            container.appendChild(setContainer);
        }

        this.validateStatementTextareas();
        this.loadPlayerStatementsFromStorage();
    }

    savePlayerStatementsToStorage() {
        try {
            const statements = {};

            for (let i = 1; i <= this.roundsCount; i++) {
                const truth1 = document.getElementById(`playerTruth1_${i}`);
                const truth2 = document.getElementById(`playerTruth2_${i}`);
                const lie = document.getElementById(`playerLie_${i}`);

                if (truth1 && truth2 && lie) {
                    statements[`set_${i}`] = {
                        truth1: truth1.value,
                        truth2: truth2.value,
                        lie: lie.value
                    };
                }
            }

            localStorage.setItem('truths_and_lies_player_statements', JSON.stringify(statements));
            DEBUG.log('Player statements saved to localStorage');

        } catch (error) {
            DEBUG.log('Error saving player statements to localStorage:', error);
        }
    }

    loadPlayerStatementsFromStorage() {
        try {
            const savedData = localStorage.getItem('truths_and_lies_player_statements');
            if (!savedData) return;

            const savedStatements = JSON.parse(savedData);

            Object.keys(savedStatements).forEach(setKey => {
                const set = savedStatements[setKey];
                const setNumber = parseInt(setKey.replace('set_', ''));

                if (setNumber && !isNaN(setNumber) && setNumber <= this.roundsCount) {
                    const truth1 = document.getElementById(`playerTruth1_${setNumber}`);
                    const truth2 = document.getElementById(`playerTruth2_${setNumber}`);
                    const lie = document.getElementById(`playerLie_${setNumber}`);

                    if (truth1) truth1.value = set.truth1 || '';
                    if (truth2) truth2.value = set.truth2 || '';
                    if (lie) lie.value = set.lie || '';
                }
            });

            DEBUG.log('Player statements loaded from localStorage');
        } catch (error) {
            DEBUG.log('Error loading player statements from storage:', error);
        }
    }

    submitStatements() {
        const statementSets = [];

        for (let i = 1; i <= this.roundsCount; i++) {
            const truth1Input = document.getElementById(`playerTruth1_${i}`);
            const truth2Input = document.getElementById(`playerTruth2_${i}`);
            const lieInput = document.getElementById(`playerLie_${i}`);

            if (!truth1Input || !truth2Input || !lieInput) {
                this.showError(`Error accessing statement inputs for round ${i}`);
                return;
            }

            const truth1 = truth1Input.value.trim();
            const truth2 = truth2Input.value.trim();
            const lie = lieInput.value.trim();

            if (!truth1 || !truth2 || !lie) {
                this.showError(`Please fill in all three statements for round ${i}`);
                return;
            }

            statementSets.push({
                round: i,
                truths: [truth1, truth2],
                lie: lie
            });
        }

        this.statementsSubmitted = true;

        const submitBtnContainer = document.querySelector('.submit-button-container');
        if (submitBtnContainer) {
            submitBtnContainer.classList.remove('hide-checkmark');

            setTimeout(() => {
                submitBtnContainer.classList.add('hide-checkmark');
            }, 2000);
        }

        if (this.ws && this.isConnected) {
            this.ws.send(JSON.stringify({
                type: 'submit_statements',
                statementSets: statementSets
            }));
        }
    }

    submitGuess(targetPlayerId, statementIndex) {
        if (!this.ws || !this.isConnected || !this.guessingPhase) {
            return;
        }

        if (targetPlayerId === this.playerId) {
            DEBUG.log('Cannot guess own statements');
            this.showGameMessage('You cannot guess your own statements!', 'game-message error');
            return;
        }

        this.myGuesses.set(targetPlayerId, statementIndex);

        this.ws.send(JSON.stringify({
            type: 'submit_guess',
            targetPlayerId: targetPlayerId,
            guessIndex: statementIndex
        }));

        const guessButtons = document.querySelectorAll('.guess-button');
        guessButtons.forEach(button => {
            if (parseInt(button.dataset.index) === statementIndex) {
                button.classList.add('selected');
            } else {
                button.classList.remove('selected');
            }
        });

        const waitingForNextMessage = document.getElementById('waitingForNextMessage');
        if (waitingForNextMessage) {
            waitingForNextMessage.classList.remove('hidden');
        }

        const radioButtons = document.querySelectorAll('input[name="guess"]');
        radioButtons.forEach(radio => {
        });

        const submitButton = document.getElementById('submit-guess-button');
        if (submitButton) {
            submitButton.classList.add('inactive');
            submitButton.textContent = 'Guess Submitted';
        }

        const guessStatus = document.querySelector('.guess-status p');
        if (guessStatus) {
            guessStatus.textContent = 'Your guess has been submitted!';
        }
    }

    displayPlayerStatements(player, statements, myGuesses) {
        DEBUG.log('Displaying guessing interface for player:', player.name, statements);

        const playerId = player.id || player.playerId;
        this.currentPlayerBeingGuessed = playerId;
        const isOwnStatements = playerId === this.playerId;
        DEBUG.log('ID Check:', isOwnStatements, playerId, this.playerId, player);
        if (isOwnStatements) {
            DEBUG.log('These are player\'s own statements - will show in inactive state');
        }

        const setId = player.setId;
        let previousGuess = null;

        if (myGuesses && setId && myGuesses[setId] !== undefined) {
            previousGuess = myGuesses[setId];
            DEBUG.log('Found previous guess for set', setId, ':', previousGuess);
        }

        const guessInstruction = document.querySelector('.guessing-instruction p');
        if (guessInstruction) {
            const questionType = player.questionType || 'lie';
            guessInstruction.textContent = `Select one ${questionType === 'truth' ? 'Truth' : 'Lie'}`;
            guessInstruction.parentElement.setAttribute('data-question-type', questionType);
        }

        const leftColumn = document.querySelector('.left-column');
        if (leftColumn) {
            leftColumn.classList.add('guessing-phase');
        }

        const playerNameElement = document.getElementById('current-player-name');
        if (playerNameElement) {
            playerNameElement.textContent = player.name;
        }

        const statementsContainer = document.getElementById('statements-container');
        if (!statementsContainer) {
            DEBUG.log('Statements container not found');
            return;
        }

        statementsContainer.innerHTML = '';

        if (!statements || statements.length === 0) {
            statementsContainer.innerHTML = '<p class="no-statements">No statements available</p>';
            return;
        }

        if (isOwnStatements) {
            const messageDiv = document.createElement('div');
            messageDiv.className = 'own-statements-message';
            messageDiv.textContent = 'This is your turn! Other players are guessing your statements.';
            statementsContainer.appendChild(messageDiv);
        }

        const statementCount = Math.min(statements.length, 3);
        for (let index = 0; index < statementCount; index++) {
            const statement = statements[index];

            const statementText = typeof statement === 'object' && statement !== null
                ? (statement.text || JSON.stringify(statement))
                : statement;

            const statementDiv = document.createElement('div');
            statementDiv.className = 'statement-option fade';

            if (isOwnStatements) {
                statementDiv.classList.add('inactive');
                statementDiv.style.pointerEvents = 'none';
                statementDiv.style.opacity = '0.7';
            }

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'guess';
            radio.id = `statement${index + 1}`;
            radio.value = index;

            if (!isOwnStatements && previousGuess !== null && previousGuess === index) {
                radio.checked = true;
                statementDiv.style.opacity = '0.8';
                statementDiv.style.borderColor = 'var(--primary-color)';
            }

            if (isOwnStatements) {
                radio.classList.add("inactive");
                radio.tabIndex = -1;
            } else {
                radio.classList.remove("inactive");
                radio.tabIndex = 0;
            }

            const label = document.createElement('label');
            label.htmlFor = `statement${index + 1}`;
            label.className = 'statement-text';
            label.textContent = statementText;

            statementDiv.appendChild(radio);
            statementDiv.appendChild(label);
            statementsContainer.appendChild(statementDiv);

            if (!isOwnStatements) {
                if (previousGuess === index) {
                    statementDiv.style.opacity = '0.8';
                    statementDiv.style.borderColor = 'var(--primary-color)';
                }

                statementDiv.addEventListener('click', (e) => {
                    e.preventDefault();
                    radio.checked = true;

                    const targetPlayerId = playerId;
                    DEBUG.log('Submitting guess:', targetPlayerId, index);

                    const allStatements = statementsContainer.querySelectorAll('.statement-option');
                    allStatements.forEach(s => {
                        s.style.opacity = '1';
                        s.style.borderColor = '';
                    });

                    statementDiv.style.opacity = '0.8';
                    statementDiv.style.borderColor = 'var(--primary-color)';

                    this.submitGuess(targetPlayerId, index);
                });
            }

            setTimeout(() => {
                statementDiv.classList.add('fade-in');
            }, 100 * index);
        }

        const submitButton = document.getElementById('submit-guess-button');
        submitButton.style.display = 'none';
    }

    updateCurrentPlayerScore(scores) {
        const currentScoreDiv = document.querySelector('.current-score');
        if (!currentScoreDiv) return;

        if (!scores) {
            currentScoreDiv.innerHTML = '';
            return;
        }

        const playerScoreObj = scores && scores.players ?
            scores.players.find(p => p.id === this.playerId) : null;

        let teamScoreObj = null;
        if (this.teamId && scores && scores.teams) {
            teamScoreObj = scores.teams.find(t => String(t.id) === String(this.teamId));

            if (!teamScoreObj && scores.teams.length > 0) {
                console.log('Team score not found:', this.teamId, 'Available teams:', scores.teams);
            }
        }

        let html = '';

        if (playerScoreObj) {
            html += `<div class="player-score">Your score: <span class="score-value">${playerScoreObj.score || 0}</span></div>`;
        }

        if (teamScoreObj && this.teamMode !== 'allVsAll') {
            html += `<div class="team-score">${this.teamName || 'Team'}: <span class="score-value">${teamScoreObj.score || 0}</span></div>`;
        }

        currentScoreDiv.innerHTML = html;
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
                    const totalLieRounds = scoreData.lieRoundsTotal || 0;
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

    getGameCodeFromUrl() {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        if (code) {
            this.gameCode = code;
            const gameCodeInput = document.getElementById('gameCode');
            if (gameCodeInput) {
                gameCodeInput.value = code;
            }
        }
    }

    initializePlayerName() {
        const playerNameInput = document.getElementById('playerName');
        if (playerNameInput) {
            const storedName = localStorage.getItem('truths_and_lies_player_name');
            if (storedName) {
                playerNameInput.value = storedName;
            } else {
                playerNameInput.value = this.getRandomName();
            }
            playerNameInput.addEventListener('focus', function () {
                this.select();
            });
        }
    }

    getRandomName() {
        const adjectives = ['Mysterious', 'Curious', 'Truthful', 'Tricky', 'Clever', 'Witty', 'Honest'];
        const nouns = ['Detective', 'Storyteller', 'Riddle', 'Mystery', 'Guesser', 'Bluffer'];

        const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)];
        const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];

        return `${randomAdjective}${randomNoun}`;
    }

    updateTeamBadgeDisplay(teamName, teamMode) {
        const shouldShowTeam = teamMode && teamMode !== 'allVsAll';

        const teamDisplay = document.getElementById('playerTeam');
        if (teamDisplay) {
            if (shouldShowTeam) {
                teamDisplay.textContent = `Team: ${teamName}`;
                teamDisplay.classList.remove('hidden');
            } else {
                teamDisplay.classList.add('hidden');
            }
        }

        const waitingScreenTeam = document.getElementById('waitingScreenTeam');
        const teamNameSpan = waitingScreenTeam?.querySelector('.team-name');

        if (waitingScreenTeam) {
            if (shouldShowTeam && teamName) {
                if (teamNameSpan) {
                    teamNameSpan.textContent = teamName;
                }
                waitingScreenTeam.classList.remove('hidden');
            } else {
                waitingScreenTeam.classList.add('hidden');
            }
        }
    }

    initializePlayersList() {
        this.playersList = document.getElementById('playersList');
        if (!this.playersList) {
            DEBUG.log('Players list element not found, will be dynamically created when needed');
        }

        this.playersContainer = document.querySelector('.game-players');
        if (!this.playersContainer) {
            this.playersContainer = document.createElement('div');
            this.playersContainer.className = 'game-players';
            document.querySelector('.game-container')?.appendChild(this.playersContainer);
        }
    }

    async joinGame() {
        const playerNameInput = document.getElementById('playerName');
        const gameCodeInput = document.getElementById('gameCode');

        this.name = playerNameInput.value.trim();
        this.gameCode = gameCodeInput.value.trim();

        if (!this.name || !this.gameCode) {
            alert('Please enter both your name and game code!');
            return;
        }

        document.getElementById('joinSection')?.classList.add('hidden');
        document.getElementById('waitingScreen')?.classList.remove('hidden');
        document.getElementById('gameController')?.classList.add('hidden');

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.gameStarted = false;
        this.gameEnded = false;
        this.guessingPhase = false;
        this.statementsSubmitted = false;
        this.isConnected = false;

        this.connectToGame();
    }

    connectToGame() {
        DEBUG.log('Connecting to game...');

        const port = window.location.port || '80';
        const isLocalDevelopment = port === '777';
        const protocol = isLocalDevelopment ? "ws:" : "wss:";
        const host = isLocalDevelopment ? "127.0.0.1" : port === '3082' ? 'deploy.ylo.one' : 'gs.team-play.online/truths-and-lies-server';
        const wsPort = isLocalDevelopment ? '8083' : port === '3082' ? '3092' : undefined;

        const wsUrl = wsPort ? `${protocol}//${host}:${wsPort}` : `${protocol}//${host}`;
        DEBUG.log('Connecting to server at:', wsUrl);

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            DEBUG.log('Connected to server');
            this.isConnected = true;
            this.updateConnectionStatus('Connected');

            const joinData = {
                type: 'join_session',
                sessionId: this.gameCode,
                name: this.name
            };

            const storedPlayerId = localStorage.getItem('truths_and_lies_player_id');

            if (storedPlayerId) {
                this.playerId = storedPlayerId;
                DEBUG.log('Attempting to reconnect with stored playerId:', this.playerId);
                joinData.playerId = this.playerId;
            } else if (this.playerId) {
                DEBUG.log('Using instance playerId for reconnection:', this.playerId);
                joinData.playerId = this.playerId;
            }

            const storedTeamId = localStorage.getItem('truths_and_lies_team_id');
            if (storedTeamId) {
                joinData.teamId = storedTeamId;
            }

            DEBUG.log('Sending join data:', joinData);
            this.ws.send(JSON.stringify(joinData));
        };

        this.ws.onclose = () => {
            DEBUG.log('Disconnected from server');
            this.isConnected = false;
            if (!this.gameEnded) {
                this.updateConnectionStatus('Disconnected, attempting to reconnect...', true);
                this.startReconnection();
            }
        };

        this.ws.onerror = (error) => {
            DEBUG.log('WebSocket error:', error);
            this.isConnected = false;
            this.updateConnectionStatus('Connection error, attempting to reconnect...', true);
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'show_message':
                    DEBUG.log('Received show_message event:', data);
                    this.showMessage(data.message, data.duration || 3000);
                    break;

                case 'countdown_started':
                    DEBUG.log('Countdown started:', data);

                    if (data.countdown && data.countdown.inCountdown) {
                        const secondsRemaining = data.countdown.secondsRemaining || data.seconds || 5;
                        DEBUG.log(`Starting countdown with ${secondsRemaining}s remaining`);
                        this.showCountdownTimer(secondsRemaining);
                    } else {
                        this.showCountdownTimer(data.seconds || 5);
                    }
                    break;

                case 'game_state':
                    DEBUG.log('Received game state:', data);

                    this.gameStarted = data.gameStarted || false;

                    this.gamePhase = data.gamePhase || 'setup';
                    this.guessingPhase = (this.gamePhase === 'guessing');

                    this.updateGameProgressBar(data);

                    if (this.gamePhase === 'setup') {
                        DEBUG.log('Game in SETUP phase - resetting countdown timer');
                        this.resetCountdownTimer();
                    }
                    else if (data.countdown && data.countdown.inCountdown) {
                        const secondsRemaining = data.countdown.secondsRemaining || 5;
                        DEBUG.log(`Game state includes countdown: ${secondsRemaining}s remaining, game phase: ${this.gamePhase}`);

                        if (this.gamePhase === 'countdown' ||
                            (this.gamePhase === 'guessing' && data.countdown.context === 'perGuess')) {
                            this.showCountdownTimer(secondsRemaining);
                        } else {
                            this.resetCountdownTimer();
                            DEBUG.log('Ignoring countdown in current game phase');
                        }
                    } else if (data.countdown && !data.countdown.inCountdown) {
                        this.resetCountdownTimer();
                    }

                    if (data.players && Array.isArray(data.players)) {
                        const myInfo = data.players.find(p => p.id === this.playerId);
                        if (myInfo) {
                            if (myInfo.teamId) {
                                this.teamId = myInfo.teamId;
                                this.teamName = myInfo.teamName || `Team ${myInfo.teamId}`;
                            } else {
                                this.teamId = 0;
                                this.teamName = null;
                            }

                            this.updateCurrentPlayerScore(data.scores);

                            const submitBtn = document.getElementById('submitStatements');
                            if (submitBtn) {
                                if (myInfo.submittedStatements) {
                                    this.statementsSubmitted = true;

                                    submitBtn.classList.add('updated');
                                    submitBtn.classList.remove('inactive', 'submitted');
                                    submitBtn.textContent = 'Update Statements';
                                } else {
                                    this.statementsSubmitted = false;
                                    submitBtn.textContent = 'I\'m Ready to Play';
                                }
                            }
                        }
                    }

                    this.updateTeamBadgeDisplay(this.teamName, data.teamMode);
                    this.roundsCount = data.roundsCount;
                    this.generateStatementInputs();

                    if (data.adminName) {
                        this.adminName = data.adminName;
                        DEBUG.log('Admin name updated:', this.adminName);
                    }

                    if (data.statusMessage !== undefined) {
                        const messageDiv = document.getElementById('start-game-message');
                        if (messageDiv) {
                            messageDiv.classList.remove('ready');

                            messageDiv.textContent = data.statusMessage || '';

                            if (data.statusIsReady) {
                                messageDiv.classList.add('ready');
                            }
                        }
                    }

                    const leftColumn = document.querySelector('.left-column');
                    const columnContent1 = document.querySelector('.column-content-1');
                    const columnContent2 = document.querySelector('.column-content-2');
                    const columnContent3 = document.querySelector('.column-content-3');
                    const resultsContainer = document.getElementById('results-container');

                    if (leftColumn) {
                        leftColumn.classList.remove('guessing-phase', 'results-phase');
                    }

                    if (leftColumn && columnContent1 && columnContent2) {
                        if (this.gamePhase === 'results') {
                            DEBUG.log('Game phase is now results');
                            leftColumn.classList.add('results-phase');
                            this.guessingPhase = false;

                            if (columnContent3 && resultsContainer) {
                                resultsContainer.classList.remove('hidden');
                            }

                            if (data.scores) {
                                DEBUG.log('Showing game results from game state:', data.scores);
                                this.scores = data.scores;
                                this.teamMode = data.teamMode || 'allVsAll';

                                this.updateCurrentPlayerScore(data.scores);

                                this.showGameResults();
                            }
                        } else if (this.gameStarted && this.gamePhase === 'guessing') {
                            leftColumn.classList.add('guessing-phase');
                            this.guessingPhase = true;

                            if (resultsContainer) {
                                resultsContainer.classList.add('hidden');
                            }

                            if (data.currentGuessingPlayer) {
                                DEBUG.log('Game state includes current guessing player:', data.currentGuessingPlayer);

                                let statementsToDisplay = [];

                                if (data.currentGuessingPlayer.statements && Array.isArray(data.currentGuessingPlayer.statements)) {
                                    statementsToDisplay = data.currentGuessingPlayer.statements.map(statement => {
                                        if (typeof statement === 'object' && statement !== null && statement.text) {
                                            return statement.text;
                                        }
                                        return statement;
                                    });
                                }

                                this.displayPlayerStatements(data.currentGuessingPlayer, statementsToDisplay, data.myGuesses);
                            }

                            if (data.countdown && data.countdown.inCountdown && data.countdown.context === 'perGuess') {
                                const secondsRemaining = data.countdown.secondsRemaining || 10;
                                this.showCountdownTimer(secondsRemaining);
                            }
                        } else {
                            leftColumn.classList.remove('guessing-phase');
                            this.guessingPhase = false;
                        }
                    }
                    break;

                case 'team_assignment':
                    DEBUG.log('Received team assignment:', data);

                    if (data.teamId) {
                        this.teamId = data.teamId;
                        this.teamName = data.teamName || `Team ${data.teamId}`;

                        this.showGameMessage(`You've been assigned to ${this.teamName}!`, 'game-message team-assignment');
                    } else {
                        this.teamId = 0;
                        this.teamName = null;
                    }

                    this.updateTeamBadgeDisplay(this.teamName, data.teamMode);
                    break;

                    if (data.teams) {
                        DEBUG.log('Received team configurations:', data.teams);
                        this.teams = data.teams;

                        this.updateTeamDisplay();
                    }


                    if (data.players && Array.isArray(data.players)) {
                        this.connectedPlayers.clear();
                        data.players.forEach(player => {
                            this.connectedPlayers.set(player.id, {
                                name: player.name || 'Player',
                                color: player.color || player.brushColor || '#000000'
                            });
                        });
                    }

                    if (this.gameStarted) {
                        DEBUG.log('Game is in progress, updating UI');
                        DEBUG.log('Game state data:', data);

                        if (data.gamePhase) {
                            DEBUG.log('Game phase updated:', data.gamePhase);

                            if (data.gamePhase === 'submission') {
                                document.getElementById('submitStatementsContainer')?.classList.remove('hidden');
                                document.getElementById('guessingContainer')?.classList.add('hidden');
                                document.getElementById('gameResultsContainer')?.classList.add('hidden');

                                if (!this.statementsSubmitted) {
                                    setTimeout(() => {
                                        document.getElementById('playerTruth1')?.focus();
                                    }, 300);
                                }
                            } else if (data.gamePhase === 'guessing') {
                                document.getElementById('guessingContainer')?.classList.remove('hidden');
                                document.getElementById('submitStatementsContainer')?.classList.add('hidden');
                                document.getElementById('gameResultsContainer')?.classList.add('hidden');
                            } else if (data.gamePhase === 'results') {
                                document.getElementById('gameResultsContainer')?.classList.remove('hidden');
                                document.getElementById('guessingContainer')?.classList.add('hidden');
                                document.getElementById('submitStatementsContainer')?.classList.add('hidden');
                            }
                        }

                        if (data.currentRound !== undefined) {
                            this.currentRound = data.currentRound;
                            DEBUG.log('Current round updated:', this.currentRound);
                        }

                        if (data.teams) {
                            DEBUG.log('Team information received:', data.teams);
                            this.teams = data.teams;

                            if (this.playerId) {
                                const myTeam = this.teams.find(team =>
                                    team.players.some(player => player.id === this.playerId));
                                if (myTeam) {
                                    this.teamId = myTeam.id;
                                    this.teamName = myTeam.name;
                                    localStorage.setItem('truths_and_lies_team_id', this.teamId);

                                    const teamDisplay = document.getElementById('playerTeam');
                                    if (teamDisplay) {
                                        teamDisplay.textContent = `Team: ${this.teamName}`;
                                        teamDisplay.classList.remove('hidden');
                                    }
                                }
                            }
                        }

                        if (data.playerScores && data.playerScores[this.playerId] !== undefined) {
                            this.score = data.playerScores[this.playerId];
                            DEBUG.log('Player score updated:', this.score);

                            const scoreDisplay = document.getElementById('playerScore');
                            if (scoreDisplay) {
                                scoreDisplay.textContent = `Score: ${this.score}`;
                                scoreDisplay.classList.remove('hidden');
                            }
                        }
                    }

                    const stillInGame = data.players?.some(player => player.id === this.playerId);

                    if (!stillInGame) {
                        document.getElementById('waitingScreen')?.classList.add('hidden');
                        document.getElementById('statementScreen')?.classList.add('hidden');
                        document.getElementById('guessingScreen')?.classList.add('hidden');
                        document.getElementById('joinSection')?.classList.remove('hidden');

                        localStorage.removeItem('truths_and_lies_player_id');
                        localStorage.removeItem('truths_and_lies_player_name');
                        localStorage.removeItem('truths_and_lies_team_id');
                        this.playerId = null;
                        this.teamId = null;
                    } else if (this.gameStarted) {
                        if (this.guessingPhase) {
                            document.getElementById('guessingScreen')?.classList.remove('hidden');
                            document.getElementById('statementScreen')?.classList.add('hidden');
                        } else {
                            document.getElementById('statementScreen')?.classList.remove('hidden');
                            document.getElementById('guessingScreen')?.classList.add('hidden');
                        }
                        document.getElementById('waitingScreen')?.classList.add('hidden');
                        document.getElementById('joinSection')?.classList.add('hidden');
                    } else {
                        document.getElementById('waitingScreen')?.classList.remove('hidden');
                        document.getElementById('statementScreen')?.classList.add('hidden');
                        document.getElementById('guessingScreen')?.classList.add('hidden');
                        document.getElementById('joinSection')?.classList.add('hidden');
                    }
                    break;

                case 'joined_game':
                    DEBUG.log('Joined game response:', data);

                    this.handleGameJoined(data);
                    break;

                case 'player_joined':
                    DEBUG.log('Player joined:', data);

                    this.connectedPlayers.set(data.playerId, {
                        name: data.name,
                        teamId: data.teamId,
                        teamName: data.teamName || (data.teamId ? `Team ${data.teamId}` : null),
                        statementsSubmitted: false,
                        color: '#' + Math.floor(Math.random() * 16777215).toString(16)
                    });

                    this.showGameMessage(`${data.name} has joined the game!`);
                    break;

                case 'start_game':
                    DEBUG.log('Game starting - transition to statement submission');

                    document.getElementById('submitStatementsContainer')?.classList.remove('hidden');
                    document.getElementById('waitingScreen')?.classList.add('hidden');
                    document.getElementById('guessingContainer')?.classList.add('hidden');
                    document.getElementById('gameResultsContainer')?.classList.add('hidden');

                    if (!this.statementsSubmitted) {
                        this.truth1 = '';
                        this.truth2 = '';
                        this.lie = '';

                        setTimeout(() => {
                            document.getElementById('playerTruth1')?.focus();
                        }, 300);
                    }

                    this.showGameMessage('Game started! Submit your 2 truths and 1 lie.', 'game-message game-start');
                    break;

                case 'start_guessing':
                    DEBUG.log('Starting guessing phase');

                    this.gameStarted = true;
                    this.guessingPhase = true;

                    document.getElementById('waitingScreen')?.classList.remove('hidden');

                    this.myGuesses = new Map();
                    this.currentPlayerBeingGuessed = null;

                    this.showGameMessage('Guessing phase has started! Choose which statement you think is a lie.', 'game-message guessing-start');
                    break;

                case 'guess_result':
                    DEBUG.log('Received guess result:', data);
                    const resultMessage = document.getElementById('guessResultMessage');
                    if (resultMessage) {
                        resultMessage.textContent = data.correct ?
                            'Correct! That was the lie.' :
                            'Wrong! That was actually a truth.';
                        resultMessage.className = data.correct ? 'correct-guess' : 'wrong-guess';
                        resultMessage.classList.remove('hidden');
                    }

                    if (data.timer && data.timer > 0) {
                        this.showCountdownTimer(data.timer);
                    }

                    if (data.score !== undefined) {
                        this.score = data.score;
                        const scoreDisplay = document.getElementById('playerScore');
                        if (scoreDisplay) {
                            scoreDisplay.textContent = `Score: ${this.score}`;
                        }
                    }
                    break;

                case 'player_left':
                    DEBUG.log('Player left:', data.playerId);

                    let playerName = 'A player';
                    if (data.playerId && this.connectedPlayers.has(data.playerId)) {
                        const leavingPlayer = this.connectedPlayers.get(data.playerId);
                        if (leavingPlayer && leavingPlayer.name) {
                            playerName = leavingPlayer.name;
                        }

                        this.connectedPlayers.delete(data.playerId);
                    }

                    this.showGameMessage(`${playerName} has left the game.`, 'game-message player-left');
                    break;

                case 'player_ready':
                    DEBUG.log('Player is ready:', data);
                    if (data.playerId) {
                        const playerData = this.connectedPlayers.get(data.playerId);
                        if (playerData) {
                            playerData.statementsSubmitted = true;
                            this.connectedPlayers.set(data.playerId, playerData);
                        }

                        const readyPlayerName = playerData?.name || 'A player';
                        this.showGameMessage(`${readyPlayerName} is ready!`, 'game-message player-ready');
                    }
                    break;

                case 'statements_submitted':
                    DEBUG.log('Player submitted statements:', data);
                    if (data.playerId) {
                        const playerData = this.connectedPlayers.get(data.playerId);
                        if (playerData) {
                            playerData.statementsSubmitted = true;
                            this.connectedPlayers.set(data.playerId, playerData);
                        }
                    }
                    break;

                case 'round_countdown':
                    DEBUG.log('Round countdown started:', data);
                    if (data.seconds) {
                        const countdownElement = document.getElementById('roundCountdown');
                        if (countdownElement) {
                            countdownElement.textContent = data.seconds;
                            countdownElement.classList.remove('hidden');

                            if (data.seconds <= 5) {
                                countdownElement.classList.add('countdown-warning');
                            } else {
                                countdownElement.classList.remove('countdown-warning');
                            }
                        }

                        if (data.seconds === 10) {
                            this.showGameMessage('Round starting in 10 seconds!', 'game-message countdown');
                        } else if (data.seconds === 5) {
                            this.showGameMessage('5 seconds remaining!', 'game-message countdown-warning');
                        }
                    }
                    break;

                case 'round_start':
                    DEBUG.log('Round started:', data);

                    this.currentRound = data.roundNumber || (this.currentRound + 1);

                    this.showGameMessage(`Round ${this.currentRound} has started!`, 'game-message round-start');

                    const countdownElement = document.getElementById('roundCountdown');
                    if (countdownElement) {
                        countdownElement.classList.add('hidden');
                    }
                    break;

                case 'next_player':
                    DEBUG.log('Next player to guess:', data);

                    if (data.player && data.statements) {
                        this.displayPlayerStatements(data.player, data.statements, null);

                        this.showGameMessage(`Now guessing ${data.player.name}'s statements!`, 'game-message next-player');
                    }
                    break;

                case 'team_assignment':
                    DEBUG.log('Team assignment received:', data);

                    if (data.teams) {
                        data.teams.forEach(team => {
                            team.players.forEach(playerId => {
                                const playerData = this.connectedPlayers.get(playerId);
                                if (playerData) {
                                    playerData.team = team.id;
                                    playerData.teamColor = team.color;
                                    this.connectedPlayers.set(playerId, playerData);
                                }
                            });
                        });

                        this.showGameMessage('Teams have been assigned!', 'game-message team-assignment');
                    }
                    break;

                case 'timer_update':
                    DEBUG.log('Timer update:', data);

                    if (data.seconds !== undefined) {
                        const timerElement = document.getElementById('guessTimer');
                        if (timerElement) {
                            timerElement.textContent = data.seconds;

                            if (data.seconds <= 5) {
                                timerElement.classList.add('timer-warning');
                            } else {
                                timerElement.classList.remove('timer-warning');
                            }
                        }

                        if (data.seconds === 10) {
                            this.showGameMessage('10 seconds remaining!', 'game-message timer');
                        } else if (data.seconds === 5) {
                            this.showGameMessage('5 seconds remaining!', 'game-message timer-warning');
                        }
                    }
                    break;

                case 'guess_result':
                    DEBUG.log('Guess result received:', data);

                    if (data.correct !== undefined) {
                        const resultClass = data.correct ? 'guess-correct' : 'guess-incorrect';
                        const resultMessage = data.correct
                            ? `Correct! That was indeed a lie.`
                            : `Incorrect! That was actually a truth.`;

                        this.showGameMessage(resultMessage, `game-message ${resultClass}`);

                        if (data.score !== undefined && data.playerId === this.playerId) {
                            this.playerScore = data.score;
                            const scoreElement = document.getElementById('playerScore');
                            if (scoreElement) {
                                scoreElement.textContent = this.playerScore;
                            }
                        }
                    }
                    break;

                case 'game_reset':
                    DEBUG.log('Game reset by admin');

                    this.truth1 = '';
                    this.truth2 = '';
                    this.lie = '';
                    this.playerScore = 0;
                    this.currentRound = 0;
                    this.statementsSubmitted = false;

                    document.getElementById('gameResultsContainer')?.classList.add('hidden');
                    document.getElementById('submitStatementsContainer')?.classList.add('hidden');
                    document.getElementById('waitingScreen')?.classList.remove('hidden');

                    const truth1Input = document.getElementById('playerTruth1');
                    const truth2Input = document.getElementById('playerTruth2');
                    const lieInput = document.getElementById('playerLie');
                    const inputElements = [truth1Input, truth2Input, lieInput];

                    inputElements.forEach(input => {
                        if (input) {
                            input.readOnly = false;
                            input.value = '';
                            input.classList.remove("inactive");
                        }
                    });

                    DEBUG.log('Statement input boxes have been cleared and enabled');

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

                    const submitButton = document.getElementById('submitStatementsBtn');
                    if (submitButton) {
                        submitButton.classList.remove('inactive');
                    }

                    this.connectedPlayers.forEach(player => {
                        player.statementsSubmitted = false;
                        player.hasGuessed = false;
                    });

                    this.showGameMessage('Game has been reset. Please enter your 2 truths and 1 lie.', 'game-message game-reset');
                    break;

                case 'error':
                    DEBUG.log('Error received:', data.message);

                    if (true) {
                        if (data.code === 'SERVER_RESTART') {
                            this.updateConnectionStatus(data.message, true);
                            localStorage.removeItem('truths_and_lies_player_id');
                            localStorage.removeItem('truths_and_lies_team_id');
                            setTimeout(() => {
                                const joinSection = document.getElementById('joinSection');
                                const gameController = document.getElementById('gameController');
                                const waitingScreen = document.getElementById('waitingScreen');
                                const submitStatementsContainer = document.getElementById('submitStatementsContainer');
                                const guessingContainer = document.getElementById('guessingContainer');
                                const gameResultsContainer = document.getElementById('gameResultsContainer');

                                if (joinSection) joinSection.classList.remove('hidden');
                                if (gameController) gameController.classList.add('hidden');
                                if (waitingScreen) waitingScreen.classList.add('hidden');
                                if (submitStatementsContainer) submitStatementsContainer.classList.add('hidden');
                                if (guessingContainer) guessingContainer.classList.add('hidden');
                                if (gameResultsContainer) gameResultsContainer.classList.add('hidden');
                            }, 500);
                        } else if (data.code === 'API_ERROR') {
                            const overlay = document.getElementById('error-overlay');
                            const errorMessage = document.getElementById('error-message');
                            errorMessage.textContent = data.message;
                            overlay.classList.remove('hidden');

                            this.showGameMessage(`Error: ${data.message}`, 'game-message error-message');
                        } else {
                            const joinSection = document.getElementById('joinSection');
                            const gameController = document.getElementById('gameController');
                            const waitingScreen = document.getElementById('waitingScreen');
                            const submitStatementsContainer = document.getElementById('submitStatementsContainer');
                            const guessingContainer = document.getElementById('guessingContainer');
                            const gameResultsContainer = document.getElementById('gameResultsContainer');

                            if (joinSection) joinSection.classList.remove('hidden');
                            if (gameController) gameController.classList.add('hidden');
                            if (waitingScreen) waitingScreen.classList.add('hidden');
                            if (submitStatementsContainer) submitStatementsContainer.classList.add('hidden');
                            if (guessingContainer) guessingContainer.classList.add('hidden');
                            if (gameResultsContainer) gameResultsContainer.classList.add('hidden');

                            if (data.message) {
                                this.showGameMessage(`Error: ${data.message}`, 'game-message error-message');
                                alert(data.message);
                            }
                        }
                    }
                    break;

                case 'api_validated':
                    if (data.validated) {
                        const overlay = document.getElementById('error-overlay');
                        overlay.classList.add('hidden');
                    }
                    break;

                case 'session_ended':
                    if (!this.gameEnded) {
                        this.gameEnded = true;
                        this.gameStarted = false;
                        this.guessingPhase = false;

                        this.showGameMessage('The game session has ended.', 'game-message session-ended');

                        setTimeout(() => {
                            window.location.reload();
                        }, 3000);
                    }
                    break;

                case 'play_again':
                    DEBUG.log('Received play again event');

                    this.gameEnded = false;
                    this.statementsSubmitted = false;
                    this.truth1 = '';
                    this.truth2 = '';
                    this.lie = '';
                    this.myGuesses.clear();

                    document.getElementById('gameResultsContainer')?.classList.add('hidden');
                    document.getElementById('waitingScreen')?.classList.remove('hidden');

                    this.showGameMessage('Starting a new game! Wait for the admin to begin.', 'game-message play-again');
                    break;

                case 'game_status_message':
                    const messageDiv = document.getElementById('start-game-message');
                    if (messageDiv) {
                        messageDiv.classList.remove('ready');

                        messageDiv.textContent = data.message || '';

                        if (data.isReady) {
                            messageDiv.classList.add('ready');
                        }
                    }
                    break;
            }
        };
    }

    updateConnectionStatus(status, isError = false) {
        const statusDiv = document.getElementById('connectionStatus');
        if (statusDiv) {
            statusDiv.textContent = status;
            statusDiv.className = isError ? 'error' : 'connected';
        }
    }

    resetCountdownTimer() {
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

    startReconnection() {
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
        }

        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        if (isMobile) {
            setTimeout(() => {
                if (!this.isConnected) {
                    this.updateConnectionStatus('Connection lost. Please refresh the page.', true);
                    const overlay = document.getElementById('connectionLostOverlay');
                    if (overlay) {
                        overlay.classList.remove('hidden');
                    }
                    if (this.reconnectInterval) {
                        clearInterval(this.reconnectInterval);
                    }
                }
            }, 5000);
        }

        this.reconnectAttempts = 0;
        this.reconnectInterval = setInterval(() => {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                clearInterval(this.reconnectInterval);
                this.updateConnectionStatus('Connection lost. Please refresh the page.', true);
                const overlay = document.getElementById('connectionLostOverlay');
                if (overlay) {
                    overlay.classList.remove('hidden');
                }
                return;
            }

            if (!this.isConnected) {
                this.reconnectAttempts++;
                this.updateConnectionStatus(`Reconnecting... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
                this.connectToGame();
            } else {
                clearInterval(this.reconnectInterval);
            }
        }, 3000);
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

    handleGameJoined(data) {
        this.isConnected = true;

        if (!this.playerId || data.forceNewId) {
            DEBUG.log('Setting new playerId:', data.playerId);
            this.playerId = data.playerId;
            localStorage.setItem('truths_and_lies_player_id', this.playerId);
        } else {
            DEBUG.log('Keeping existing playerId:', this.playerId);
        }

        if (data.teamId) {
            this.teamId = data.teamId;
            this.teamName = data.teamName || `Team ${data.teamId}`;
            localStorage.setItem('truths_and_lies_team_id', this.teamId);

            this.showGameMessage(`You've been assigned to ${this.teamName}!`, 'game-message team-assignment');
        } else {
            this.teamId = 0;
            this.teamName = null;
        }

        this.updateTeamBadgeDisplay(this.teamName, data.teamMode);

        localStorage.setItem('truths_and_lies_player_name', this.name);
        localStorage.setItem('truths_and_lies_player_id', this.playerId);
        localStorage.setItem('truths_and_lies_game_code', this.gameCode);

        this.connectedPlayers.set(this.playerId, {
            name: this.name,
            teamId: this.teamId,
            teamName: this.teamName,
            statementsSubmitted: false
        });

        document.getElementById('joinSection').classList.add('hidden');
        const gameController = document.getElementById('gameController');
        const waitingScreen = document.getElementById('waitingScreen');
        waitingScreen.classList.remove('hidden');

        if (data.gameInstructions) {
            const waitingScreenInstructions = document.getElementById('waitingScreenInstructions');
            if (waitingScreenInstructions) {
                const instructionsList = waitingScreenInstructions.querySelector('.instructions-list');
                if (instructionsList) {
                    instructionsList.innerHTML = data.gameInstructions;
                } else {
                    waitingScreenInstructions.textContent = data.gameInstructions;
                }
                waitingScreenInstructions.classList.remove('hidden');
            }
        }

        if (this.teamId && this.teamName) {
            const waitingScreenTeam = document.getElementById('waitingScreenTeam');
            if (waitingScreenTeam) {
                const teamNameSpan = waitingScreenTeam.querySelector('.team-name');
                if (teamNameSpan) {
                    teamNameSpan.textContent = this.teamName;
                } else {
                    waitingScreenTeam.textContent = `You're on Team: ${this.teamName}`;
                }
                waitingScreenTeam.classList.remove('hidden');
            }
        }

        if (data.exampleStatements) {
            this.updateExampleTicker(data.exampleStatements);
        } else {
            this.updateExampleTicker([]);
        }

        const timerDisplay = document.querySelector('#playerCountdownTimer .timer-display');
        if (timerDisplay) {
            timerDisplay.textContent = data.timeRemaining || '--';
        }

        if (this.gameStarted) {
            if (gameController) {
                gameController.classList.remove('hidden');
            }

            if (this.guessingPhase) {
                const guessingContainer = document.getElementById('guessingContainer');
                const submitStatementsContainer = document.getElementById('submitStatementsContainer');

                if (guessingContainer) guessingContainer.classList.remove('hidden');
                if (submitStatementsContainer) submitStatementsContainer.classList.add('hidden');

                if (waitingScreen) waitingScreen.classList.add('hidden');

                const statementScreen = document.getElementById('statementScreen');
                if (statementScreen) statementScreen.classList.remove('hidden');
            } else {
                const submitStatementsContainer = document.getElementById('submitStatementsContainer');
                const guessingContainer = document.getElementById('guessingContainer');

                if (submitStatementsContainer) submitStatementsContainer.classList.remove('hidden');
                if (guessingContainer) guessingContainer.classList.add('hidden');
            }
        } else {
            if (waitingScreen) waitingScreen.classList.remove('hidden');
            if (gameController) gameController.classList.add('hidden');

            const submitStatementsContainer = document.getElementById('submitStatementsContainer');
            if (submitStatementsContainer) submitStatementsContainer.classList.remove('hidden');
        }

        if (gameController) {
            const playerNameElement = gameController.querySelector('.player-name');
            if (playerNameElement) playerNameElement.textContent = this.name;
        }
    }

    updateConnectionStatus(status) {
        const statusElement = document.querySelector('.connection-status');
        if (statusElement) {
            statusElement.textContent = status;
            statusElement.className = 'connection-status ' + status.toLowerCase();
        }
    }

    showReconnectPrompt() {
        const shouldReconnect = confirm('Connection lost. Try to reconnect?');
        if (shouldReconnect) {
            this.connectToGame();
        }
    }



    hideResultScreens(showWaitingScreen = true) {

    }

    validateStatementTextareas() {
        if (this.validateTextareasTimeout) {
            clearTimeout(this.validateTextareasTimeout);
        }

        this.validateTextareasTimeout = setTimeout(() => {
            let allFieldsComplete = true;

            for (let i = 1; i <= this.roundsCount; i++) {
                const truth1 = document.getElementById(`playerTruth1_${i}`)?.value.trim() || '';
                const truth2 = document.getElementById(`playerTruth2_${i}`)?.value.trim() || '';
                const lie = document.getElementById(`playerLie_${i}`)?.value.trim() || '';

                if (!truth1 || !truth2 || !lie) {
                    allFieldsComplete = false;
                    break;
                }
            }

            const submitButton = document.getElementById('submitStatements');
            if (submitButton) {
                submitButton.setAttribute('aria-busy', !allFieldsComplete);

                if (!allFieldsComplete) {
                    submitButton.classList.add('inactive');
                } else {
                    submitButton.classList.remove('inactive');
                }
            }
        }, 200);
    }

    showError(message) {
        const errorOverlay = document.getElementById('error-overlay');
        const errorMessage = document.getElementById('error-message');

        if (errorOverlay && errorMessage) {
            errorMessage.textContent = message;
            errorOverlay.classList.remove('hidden');

            setTimeout(() => {
                errorOverlay.classList.add('hidden');
            }, 3000);
        } else {
            alert(message);
        }
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    updateExampleTicker(examples) {
        DEBUG.log('Updating player ticker with examples from server:', examples);

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



    showCountdownTimer(seconds) {
        this.resetCountdownTimer();

        const timerElement = document.getElementById('countdownTimer');
        const timerDisplay = timerElement.querySelector('.timer-display');
        const timerProgress = timerElement.querySelector('.timer-circle-progress');

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

        let timeLeft = seconds;
        this.countdownInterval = setInterval(() => {
            timeLeft--;
            timerDisplay.textContent = timeLeft;
            const offset = circumference * (1 - timeLeft / seconds);
            timerProgress.style.strokeDashoffset = offset;

            const percentRemaining = timeLeft / seconds;

            timerElement.classList.remove('timer-state-green', 'timer-state-orange', 'timer-state-red');

            if (timeLeft === 2 && this.gamePhase === 'guessing') {
                const isOwnStatements = this.currentPlayerBeingGuessed === this.playerId;

                if (!isOwnStatements && 1 === 2) {
                    const selectedRadio = document.querySelector('input[name="guess"]:checked');

                    if (!selectedRadio) {
                        DEBUG.log('Auto-selecting and submitting random guess');
                        const availableOptions = document.querySelectorAll('input[name="guess"]');

                        if (availableOptions.length > 0) {
                            const randomIndex = Math.floor(Math.random() * availableOptions.length);
                            const randomOption = availableOptions[randomIndex];

                            const parentDiv = randomOption.closest('.statement-option');
                            if (parentDiv) {
                                DEBUG.log('Clicking parent div to trigger submission');
                                parentDiv.click();
                            } else {
                                randomOption.checked = true;
                            }
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
            }
        }, 1000);
    }
}

let controller;
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
    controller = new PlayerController();

    if (document.visibilityState === 'visible') {
        requestWakeLock();
    }

    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) {
        joinBtn.addEventListener('click', () => controller.joinGame());
    }

    window.joinGame = () => controller.joinGame();
});
