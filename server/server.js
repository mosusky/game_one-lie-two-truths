import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const config = {
    host: process.env.WS_HOST || 'localhost',
    port: parseInt(process.env.WS_PORT) || 8082,
    secure: process.env.WS_SECURE === 'true',
    runAsModule: process.env.RUN_AS_MODULE !== 'false',
    ssl: {
        cert: process.env.SSL_CERT_PATH,
        key: process.env.SSL_KEY_PATH
    },
    enableTeamPlayLogging: process.env.ENABLE_TEAMPLAY_LOGGING === 'true',
    enableApiValidation: process.env.ENABLE_API_VALIDATION === 'true',
    defaultAnswerTime: parseInt(process.env.DEFAULT_ANSWER_TIME) || 10,
    maxTeams: parseInt(process.env.MAX_TEAMS) || 4,
    exampleStatements: [
        [
            "I've visited 15 different countries",
            "I can speak three languages fluently",
            "I once won a pie-eating contest"
        ],
        [
            "I have a collection of over 200 vinyl records",
            "I've never broken a bone in my body",
            "I was an extra in a popular TV show"
        ],
        [
            "I can juggle five balls at once",
            "I once met a famous celebrity at a grocery store",
            "I'm afraid of heights"
        ],
        [
            "I've been skydiving twice",
            "I can play the piano by ear",
            "I've eaten insects as a delicacy in Thailand"
        ]
    ]
};

async function validateApiCode(code) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'admin.team-play.online',
            path: `/api/validate-code/${code}`,
            method: 'GET',
            headers: {
                'Authorization': process.env.TEAMPLAY_API_TOKEN
            }
        };

        const req = https.request(options, (res) => {
            console.log('API validation response status:', res.statusCode);
            switch (res.statusCode) {
                case 204:
                    resolve({ valid: true });
                    break;
                case 404:
                    resolve({ valid: false, error: 'Invalid API code. Please check your code and try again.' });
                    break;
                case 423:
                    resolve({ valid: false, error: 'This API code has expired. Please obtain a new code.' });
                    break;
                default:
                    resolve({ valid: false, error: 'API validation failed. Please try again later.' });
            }
        });

        req.on('error', () => {
            resolve({ valid: false, error: 'Failed to validate API code. Please check your internet connection.' });
        });

        req.end();
    });
}

export let wss;

if (config.runAsModule) {
    wss = new WebSocketServer({ noServer: true });
    console.log(`Truths and Lies Game WebSocket server is up and running`);
} else if (config.secure) {
    const server = https.createServer({
        cert: fs.readFileSync(config.ssl.cert),
        key: fs.readFileSync(config.ssl.key)
    });
    wss = new WebSocketServer({ server });
    server.listen(config.port, config.host, () => {
        console.log(`Secure WebSocket server running on wss://${config.host}:${config.port}`);
    });
} else {
    wss = new WebSocketServer({
        host: config.host,
        port: config.port
    });

    console.log(`WebSocket server running on ws://${config.host}:${config.port}`);
}

const activeGames = new Map();

const clients = new Map();
const playerGames = new Map();

class Game {
    constructor(adminSocket, gameCode) {
        this.gameCode = gameCode || uuidv4();
        this.admin = adminSocket;
        this.adminName = null;
        this.adminTeamId = 0;
        this.adminTeamName = null;
        this.players = new Map();
        this.disconnectedPlayers = new Map();
        this.apiValidated = false;
        this.apiCode = null;
        this.gameEvents = [];

        this.gamePhase = 'setup';
        this.gameStarted = false;
        this.gameEnded = false;

        this.countdownEndTime = null;
        this.countdownDuration = 0;
        this.countdownContext = null;
        this.countdownTimeoutId = null;

        this.teams = new Map();
        this.teamNames = new Map();
        this.teamMode = 'allVsAll';
        this.maxTeams = config.maxTeams;

        this.availableTeamNames = [
            'Truth Seekers', 'Lie Detectors', 'Fact Finders', 'Myth Busters',
            'Reality Checkers', 'Truthsayers', 'Fiction Finders', 'Deception Detectives',
            'Truth Trackers', 'Lie Lords', 'Fact Force', 'Honesty Heroes',
            'Story Sleuths', 'Tall Tale Trackers', 'Bluff Busters', 'Honest Brokers'
        ];

        this.answerTime = config.defaultAnswerTime;
        this.currentRound = 0;
        this.roundsCount = 5;

        this.statusMessage = '';
        this.statusIsReady = false;

        this.readyPlayers = new Set();
        this.scores = new Map();
        this.currentPlayerIndex = 0;
        this.currentStatementIndex = 0;

        this.enableTeamPlayLogging = config.enableTeamPlayLogging;

        activeGames.set(this.gameCode, this);
    }

    addPlayer(playerSocket, playerName, existingPlayerId = null, existingTeam = null) {
        const playerId = existingPlayerId || uuidv4();
        console.log('Adding player:', {
            name: playerName,
            id: playerId,
            isReconnect: !!existingPlayerId,
            existingTeam
        });

        if (playerGames.has(playerId) && playerGames.get(playerId) !== this.gameCode) {
            console.log('Player already in another game:', playerId);
            return false;
        }

        const existingPlayer = this.players.get(playerId);
        const disconnectedPlayer = this.disconnectedPlayers.get(playerId);

        let teamId = existingTeam ||
                    (existingPlayer ? existingPlayer.teamId :
                     disconnectedPlayer ? disconnectedPlayer.teamId : 0);

        if (existingPlayer) {
            console.log('Player reconnecting with existing data:', playerId);
            existingPlayer.socket = playerSocket;
            existingPlayer.name = playerName;
            existingPlayer.teamId = teamId;
        } else if (disconnectedPlayer) {
            console.log('Player reconnecting from disconnected state:', playerId);
            this.players.set(playerId, {
                socket: playerSocket,
                name: playerName,
                teamId: teamId || disconnectedPlayer.teamId,
                ready: disconnectedPlayer.ready || false,
                submittedStatements: disconnectedPlayer.submittedStatements || false,
                statements: disconnectedPlayer.statements || { truths: [], lie: null },
                guesses: disconnectedPlayer.guesses || new Map(),
                score: disconnectedPlayer.score || 0
            });

            if (disconnectedPlayer.submittedStatements) {
                this.readyPlayers.add(playerId);
            }

            this.disconnectedPlayers.delete(playerId);
            console.log('Restored player data from disconnected state:', playerId);
        } else {
            console.log('New player joining:', playerId);
            this.players.set(playerId, {
                socket: playerSocket,
                name: playerName,
                teamId: teamId,
                ready: false,
                submittedStatements: false,
                statements: {
                    truths: [],
                    lie: null
                },
                guesses: new Map(),
                score: 0
            });
        }

        playerGames.set(playerId, this.gameCode);

        clients.set(playerSocket, {
            type: 'player',
            gameCode: this.gameCode,
            playerId: playerId
        });

        if (this.teamMode !== 'allVsAll') {
            if (teamId > 0) {
                if (!this.teams.has(teamId)) {
                    this.teams.set(teamId, []);
                }
                this.teams.get(teamId).push(playerId);
            } else {
                const teamSizes = new Map();
                for (let i = 1; i <= this.maxTeams; i++) {
                    if (this.teams.has(i)) {
                        teamSizes.set(i, this.teams.get(i).length);
                    } else {
                        teamSizes.set(i, 0);
                    }
                }

                let smallestTeamId = 1;
                let smallestTeamSize = Number.MAX_SAFE_INTEGER;

                for (const [id, size] of teamSizes.entries()) {
                    if (size < smallestTeamSize) {
                        smallestTeamId = id;
                        smallestTeamSize = size;
                    }
                }

                teamId = smallestTeamId;
                this.players.get(playerId).teamId = teamId;

                if (!this.teams.has(teamId)) {
                    this.teams.set(teamId, []);
                    if (!this.teamNames.has(teamId)) {
                        const usedNames = Array.from(this.teamNames.values());
                        const availableNames = this.availableTeamNames.filter(name => !usedNames.includes(name));

                        const teamName = availableNames.length > 0
                            ? availableNames[Math.floor(Math.random() * availableNames.length)]
                            : `Team ${teamId}`;

                        this.teamNames.set(teamId, teamName);
                    }
                }

                this.teams.get(teamId).push(playerId);

                console.log(`Auto-assigned player ${playerName} (${playerId}) to team ${teamId} (${this.teamNames.get(teamId)})`);
            }
        }

        this.sendToAll({
            type: 'player_joined',
            playerId: playerId,
            name: playerName,
            teamId: teamId,
            gamePhase: this.gamePhase,
            gameStarted: this.gameStarted
        });

        playerSocket.send(JSON.stringify({
            type: 'joined_game',
            playerId: playerId,
            teamId: teamId,
            teamName: teamId > 0 ? this.teamNames.get(teamId) : null,
            gamePhase: this.gamePhase,
            gameStarted: this.gameStarted,
            exampleStatements: config.exampleStatements
        }));

        this.broadcastGameState(playerId);

        this.broadcastGameState();

        return true;
    }

    removePlayer(playerId) {
        console.log("player removed", playerId);
        const player = this.players.get(playerId);
        if (player) {
            const playerData = {
                name: player.name,
                teamId: player.teamId,
                ready: player.ready,
                submittedStatements: player.submittedStatements,
                statements: player.statements,
                guesses: player.guesses,
                score: player.score,
                lastDisconnectedAt: Date.now()
            };
            this.disconnectedPlayers.set(playerId, playerData);
            console.log(`Stored player data for ${playerId} in disconnectedPlayers map`);

            if (player.teamId > 0 && this.teams.has(player.teamId)) {
                const teamPlayers = this.teams.get(player.teamId);
                const playerIndex = teamPlayers.indexOf(playerId);
                if (playerIndex !== -1) {
                    teamPlayers.splice(playerIndex, 1);

                    if (teamPlayers.length === 0) {
                        this.teams.delete(player.teamId);
                    }
                }
            }

            this.readyPlayers.delete(playerId);

            this.players.delete(playerId);
            playerGames.delete(playerId);

            this.broadcastToAll({
                type: 'player_left',
                playerId: playerId,
                name: player.name,
                teamId: player.teamId
            });
        }
    }

    safeStringify(data) {
        if (typeof data === 'string') {
            return data;
        }
        return JSON.stringify(data);
    }

    sendToAdmin(data) {
        if (this.admin && this.admin.readyState === WebSocket.OPEN) {
            this.admin.send(this.safeStringify(data));
        }
    }

    sendToPlayer(playerId, data) {
        const player = this.players.get(playerId);
        if (player && player.socket.readyState === WebSocket.OPEN) {
            player.socket.send(this.safeStringify(data));
        }
    }

    broadcastToAll(data) {
        this.players.forEach(player => {
            if (player.socket && player.socket.readyState === WebSocket.OPEN) {
                player.socket.send(this.safeStringify(data));
            }
        });

        this.sendToAdmin(data);
    }

    broadcast(data) {
        const message = this.safeStringify(data);
        this.players.forEach(player => {
            if (player.socket.readyState === WebSocket.OPEN) {
                player.socket.send(message);
            }
        });
    }

    startCountdown(seconds, context = 'gameStart') {
        if (this.countdownTimeoutId) {
            clearTimeout(this.countdownTimeoutId);
        }

        this.countdownContext = context; 
        this.countdownDuration = seconds;
        this.countdownEndTime = Date.now() + (seconds * 1000);
        console.log(`Started ${context} countdown for ${seconds} seconds, ending at ${new Date(this.countdownEndTime).toISOString()}`);

        return this.getCountdownInfo();
    }

    getCountdownRemaining() {
        if (!this.countdownEndTime) return 0;

        const remaining = Math.ceil((this.countdownEndTime - Date.now()) / 1000);
        return Math.max(0, remaining); 
    }

    scheduleCountdownCompletion(seconds, callback) {
        this.countdownTimeoutId = setTimeout(() => {
            this.countdownEndTime = null;
            this.countdownTimeoutId = null;

            if (typeof callback === 'function') {
                callback();
            }
        }, seconds * 1000);
    }

    getCountdownInfo() {
        if (!this.countdownEndTime || (this.gamePhase === 'setup' && !this.gameStarted)) {
            return { inCountdown: false };
        }

        const secondsRemaining = this.getCountdownRemaining();

        if (secondsRemaining <= 0) {
            return { inCountdown: false };
        }

        return {
            inCountdown: true,
            secondsRemaining: secondsRemaining,
            totalDuration: this.countdownDuration,
            context: this.countdownContext || 'gameStart'
        };
    }

    handlePlayerGuess(playerId, targetPlayerId, guessIndex) {
        console.log(`Player ${playerId} guessing statement ${guessIndex} for player ${targetPlayerId}`);
        if (this.gamePhase !== 'guessing') return { success: false, error: 'Not in guessing phase' };

        const player = this.players.get(playerId);
        if (!player) return { success: false, error: 'Player not found' };

        const targetPlayer = this.players.get(targetPlayerId);
        if (!targetPlayer) return { success: false, error: 'Target player not found' };

        if (!player.guesses) player.guesses = {};
        player.guesses[targetPlayerId] = guessIndex;

        const isCorrect = targetPlayer.lieIndex === guessIndex;

        this.gameEvents.push({
            type: 'player_guess',
            time: new Date().toISOString(),
            playerId,
            name: player.name,
            targetPlayerId,
            targetPlayerName: targetPlayer.name,
            guessIndex,
            isCorrect
        });

        if (isCorrect) {
            if (this.teamMode === 'allVsAll') {
                player.score = (player.score || 0) + 1;
            } else {
                const teamId = player.teamId;
                if (teamId) {
                    this.teamScores[teamId] = (this.teamScores[teamId] || 0) + 1;
                }
            }
        }

        return {
            success: true,
            isCorrect,
            correctIndex: targetPlayer.lieIndex
        };
    }

    submitStatements(playerId, statements) {
        if (playerId === 'admin') {
            if (!statements.truths || !Array.isArray(statements.truths) || statements.truths.length !== 2) {
                return { success: false, error: 'You must provide exactly 2 true statements' };
            }
            if (statements.lie === null || statements.lie === undefined || statements.lie === '') {
                return { success: false, error: 'You must provide 1 false statement' };
            }

            this.adminStatements = {
                truths: statements.truths,
                lie: statements.lie
            };

            this.readyPlayers.add('admin');

            this.broadcastToAll({
                type: 'statements_submitted',
                playerId: 'admin',
                name: this.adminName || 'Admin',
                ready: true
            });

            this.broadcastGameState();
            return { success: true };
        }

        const player = this.players.get(playerId);
        if (!player) return false;

        if (!statements.truths || !Array.isArray(statements.truths) || statements.truths.length !== 2) {
            return { success: false, error: 'You must provide exactly 2 true statements' };
        }
        if (statements.lie === null || statements.lie === undefined || statements.lie === '') {
            return { success: false, error: 'You must provide 1 false statement' };
        }

        if (!player.statements) {
            player.statements = {};
        }

        player.statements.truths = statements.truths;
        player.statements.lie = statements.lie;
        player.submittedStatements = true;
        console.log(player.statements, 123);

        this.readyPlayers.add(playerId);
        player.ready = true;

        this.broadcastToAll({
            type: 'statements_submitted',
            playerId: playerId,
            name: player.name,
            ready: true,
            statements: player.statements
        });

        this.broadcastGameState();
        return { success: true };
    }

    setPlayerReady(playerId, isReady) {
        const player = this.players.get(playerId);
        if (!player) return false;

        player.ready = isReady;

        if (isReady) {
            this.readyPlayers.add(playerId);
        } else {
            this.readyPlayers.delete(playerId);
        }

        this.broadcastToAll({
            type: 'player_ready_status',
            playerId: playerId,
            name: player.name,
            ready: isReady
        });

        return true;
    }

    setAdminInfo(adminName) {
        this.adminName = adminName;
        console.log('Admin name set to:', this.adminName);

        this.broadcastToAll({
            type: 'admin_info_updated',
            adminName: this.adminName
        });

        return true;
    }

    setTeamMode(mode) {
        if (!['allVsAll', 'randomTeams', 'adminTeams'].includes(mode)) {
            return { success: false, error: 'Invalid team mode' };
        }

        this.teamMode = mode;

        this.teams.clear();

        this.players.forEach(player => {
            player.teamId = 0;
        });

        if (mode === 'randomTeams' || mode === 'adminTeams') {
            this.assignTeams();
        }

        this.broadcastToAll({
            type: 'team_mode_updated',
            mode: this.teamMode
        });

        this.broadcastGameState();
        return { success: true };
    }

    assignTeams() {
        if (this.teamMode === 'allVsAll') {
            return { success: true, message: 'All vs All mode activated' };
        }

        this.teams.clear();
        this.teamNames.clear();

        const playerIds = Array.from(this.players.keys());

        if (this.teamMode === 'randomTeams' || this.teamMode === 'adminTeams') {
            let teamCount = 4;

            const shuffledTeamNames = [...this.availableTeamNames].sort(() => 0.5 - Math.random());

            for (let i = 1; i <= teamCount; i++) {
                this.teams.set(i, []);
                const teamName = shuffledTeamNames[i-1] || `Team ${i}`;
                this.teamNames.set(i, teamName);
            }

            const shuffled = [...playerIds].sort(() => 0.5 - Math.random());

            shuffled.forEach((playerId, index) => {
                const teamId = (index % teamCount) + 1;
                this.teams.get(teamId).push(playerId);

                const player = this.players.get(playerId);
                if (player) {
                    player.teamId = teamId;
                }
            });
        }

        this.teams.forEach((players, teamId) => {
            this.scores.set(teamId, 0);
        });

        if (this.teamMode !== 'allVsAll' && this.teams.has(2)) {
            this.adminTeamId = 2;
            this.adminTeamName = this.teamNames.get(2);
        } else if (this.teamMode !== 'allVsAll' && this.teams.has(1)) {
            this.adminTeamId = 1;
            this.adminTeamName = this.teamNames.get(1);
        } else {
            this.adminTeamId = 0;
            this.adminTeamName = null;
        }

        this.broadcastToAll({
            type: 'teams_assigned',
            teams: Array.from(this.teams.entries())
        });

        this.broadcastGameState();
        return { success: true };
    }

    getScores() {
        const scores = {
            teams: [],
            players: [],
            bestGuessers: [],  
            bestDeceivers: [],  
            lieRoundsTotal: this.lieRoundsTotal || 0 
        };

        for (const [playerId, player] of this.players.entries()) {
            if (player.score === undefined) player.score = 0;
            if (player.lieCorrectCount === undefined) player.lieCorrectCount = 0;

            const totalGuesses = player.guesses ? Object.keys(player.guesses).length : 0;
            const correctGuesses = player.score;

            let deceptionRate = 0.0;

            if (player.guessesReceived && player.guessesReceived > 0) {
                deceptionRate = player.successfulDeceptions / player.guessesReceived;
                console.log(`Player ${player.name} deception rate: ${player.successfulDeceptions}/${player.guessesReceived} = ${deceptionRate}`);
            }

            scores.players.push({
                id: playerId,
                name: player.name,
                score: player.score,
                teamId: player.teamId,
                teamName: player.teamId ? this.teamNames.get(player.teamId) || `Team ${player.teamId}` : null,
                lieCorrectCount: player.lieCorrectCount,
                correctGuesses,
                totalGuesses,
                guessSuccessRate: totalGuesses > 0 ? correctGuesses / totalGuesses : 0,
                deceptionRate,
                type: 'player'
            });
        }

        if (this.adminName) {
            if (this.adminScore === undefined) this.adminScore = 0;
            if (this.adminLieCorrectCount === undefined) this.adminLieCorrectCount = 0;

            const adminTotalGuesses = this.adminGuesses ? Object.keys(this.adminGuesses).length : 0;

            const adminCorrectGuesses = this.adminScore;

            let adminDeceptionRate = 0.0;

            if (this.adminGuessesReceived && this.adminGuessesReceived > 0) {
                adminDeceptionRate = this.adminSuccessfulDeceptions / this.adminGuessesReceived;
                console.log(`Admin deception rate: ${this.adminSuccessfulDeceptions}/${this.adminGuessesReceived} = ${adminDeceptionRate}`);
            }

            scores.players.push({
                id: 'admin',
                name: this.adminName || 'Admin',
                score: this.adminScore,
                teamId: this.adminTeamId,
                teamName: this.adminTeamId ? this.teamNames.get(this.adminTeamId) || `Team ${this.adminTeamId}` : null,
                lieCorrectCount: this.adminLieCorrectCount,
                correctGuesses: adminCorrectGuesses,
                totalGuesses: adminTotalGuesses,
                guessSuccessRate: adminTotalGuesses > 0 ? adminCorrectGuesses / adminTotalGuesses : 0,
                deceptionRate: adminDeceptionRate,
                type: 'admin'
            });
        }

        if (this.teamMode !== 'allVsAll') {
            if (!this.teamScores) {
                this.teamScores = {};
            }

            const teamScores = {};

            const playersByTeam = {};

            for (const player of scores.players) {
                if (player.teamId) {
                    if (!playersByTeam[player.teamId]) {
                        playersByTeam[player.teamId] = [];
                    }
                    playersByTeam[player.teamId].push(player);
                }
            }

            for (const teamId in playersByTeam) {
                teamScores[teamId] = playersByTeam[teamId].reduce((sum, player) => sum + player.score, 0);

                this.teamScores[teamId] = teamScores[teamId];

                scores.teams.push({
                    id: teamId,
                    name: this.teamNames.get(parseInt(teamId)) || `Team ${teamId}`,
                    score: teamScores[teamId],
                    players: playersByTeam[teamId].map(p => p.id),
                    type: 'team'
                });
            }
        }

        scores.players.sort((a, b) => b.score - a.score);

        scores.players.forEach(player => {
        });

        scores.bestGuessers = [...scores.players]
            .filter(p => p.lieCorrectCount > 0) 
            .sort((a, b) => b.lieCorrectCount - a.lieCorrectCount)
            .slice(0, 3);

        scores.bestDeceivers = [...scores.players]
            .filter(p => p.deceptionRate !== undefined)
            .sort((a, b) => b.deceptionRate - a.deceptionRate)
            .slice(0, 3);

        scores.teams.sort((a, b) => b.score - a.score);

        return scores;
    }

    getTeamsForBroadcast() {
        const teamsObj = Object.fromEntries(this.teams);

        if (this.teamMode === 'randomTeams' || this.teamMode === 'adminTeams') {
            for (let i = 1; i <= 4; i++) {
                if (!teamsObj[i]) {
                    teamsObj[i] = [];
                }
            }
        }

        return teamsObj;
    }

    assignPlayerToTeam(playerId, teamId) {
        console.log(playerId, teamId, 123);
        const player = this.players.get(playerId);
        if (!player) return { success: false, error: 'Player not found' };

        if (player.teamId > 0 && this.teams.has(player.teamId)) {
            const currentTeam = this.teams.get(player.teamId);
            const index = currentTeam.indexOf(playerId);
            if (index !== -1) {
                currentTeam.splice(index, 1);
            }
        }

        if (teamId > 0) {
            if (!this.teams.has(teamId)) {
                this.teams.set(teamId, []);
            }
            this.teams.get(teamId).push(playerId);
        }

        player.teamId = teamId;

        this.broadcastToAll({
            type: 'player_team_updated',
            playerId: playerId,
            name: player.name,
            teamId: teamId
        });

        this.broadcastGameState();
        return { success: true };
    }

    startGame(settings = {}) {
        if (this.gameStarted) {
            return { success: false, error: 'Game already started' };
        }

        if (settings.answerTime && settings.answerTime >= 5 && settings.answerTime <= 60) {
            this.answerTime = settings.answerTime;
        }
        if (settings.roundsCount && settings.roundsCount >= 1 && settings.roundsCount <= 20) {
            this.roundsCount = settings.roundsCount;
        }

        if (this.teamMode !== 'allVsAll' && this.teams.size === 0) {
            this.assignTeams();
        }

        this.gameStarted = true;
        this.gameEnded = false;
        this.gamePhase = 'countdown'; 
        this.currentRound = 1;
        this.currentPlayerIndex = 0;
        this.currentStatementIndex = 0;

        this.scores.clear();

        if (this.teamMode !== 'allVsAll') {
            this.teams.forEach((players, teamId) => {
                this.scores.set(teamId, 0);
            });
        } else {
            this.players.forEach((player, playerId) => {
                this.scores.set(playerId, 0);
            });
        }

        this.gameEvents.push({
            type: 'game_started',
            time: new Date().toISOString(),
            teamMode: this.teamMode,
            playerCount: this.players.size
        });

        this.startNewRound();

        return { success: true };
    }

    resetSession() {
        this.gameStarted = false;
        this.gameEnded = false;
        this.gamePhase = 'setup';
        this.currentRound = 0;
        this.currentPlayerIndex = 0;
        this.gameEvents = [];
        this.teamScores = {};
        this.lieRoundsTotal = 0;

        this.adminScore = 0;
        this.adminGuesses = {};
        this.adminLieGuessCount = 0;
        this.adminLieCorrectCount = 0;
        this.adminGuessesReceived = 0;
        this.adminSuccessfulDeceptions = 0;

        this.currentGuessingPlayerId = null;
        this.playerOrder = [];
        this.inCountdown = false;
        this.countdownSeconds = 0;
        this.countdownContext = null;
        this.countdownCallback = null;
        this.countdownEndTime = null; 


        if (this.countdownTimeoutId) {
            clearTimeout(this.countdownTimeoutId);
            this.countdownTimeoutId = null;
            console.log('Cleared scheduled timer callback');
        }

        if (this.teamMode !== 'adminManaged') {
            this.teams.clear();
        }

        this.players.forEach(player => {
            player.ready = false;
            player.statements = {}; 
            player.lieIndex = null;
            player.guesses = {};
            player.score = 0;
            player.submittedStatements = false; 
            player.lieGuessCount = 0;
            player.lieCorrectCount = 0;
            player.guessesReceived = 0;
            player.successfulDeceptions = 0;

            if (this.teamMode !== 'adminManaged') {
                player.teamId = null;
            }
        });

        this.readyPlayers.clear();

        this.broadcastToAll({
            type: 'session_reset'
        });

        this.broadcastGameState();
        return { success: true };
    }

    startNewRound() {
        if (this.currentRound > this.roundsCount) {
            return;
        }

        const playerIds = Array.from(this.players.keys());
        if (playerIds.length === 0) return;

        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % playerIds.length;
        this.currentStatementMapping = ['truth', 'truth', 'lie'];

        this.currentStatementMapping.sort(() => Math.random() - 0.5);

        this.broadcastToAll({
            type: 'new_round',
            round: this.currentRound,
            totalRounds: this.roundsCount,
            playerIndex: this.currentPlayerIndex
        });

        this.broadcastGameState();
    }

    advanceRound() {
        if (!this.gameStarted || this.gamePhase !== 'guessing') {
            return { success: false, error: 'Game not in guessing phase' };
        }

        this.currentRound++;

        if (this.currentRound > this.roundsCount) {
            return;
        }

        const eligiblePlayers = Array.from(this.players.entries())
            .filter(([playerId, player]) => player.submittedStatements)
            .map(([playerId]) => playerId);

        if (eligiblePlayers.length === 0) {
            console.log('No eligible players with statements!');
            return;
        }

        this.currentPlayerIndex = (this.currentRound - 1) % eligiblePlayers.length;
        this.currentStatementIndex = 0;
        const currentPlayerId = eligiblePlayers[this.currentPlayerIndex];
        const currentPlayer = this.players.get(currentPlayerId);

        if (!currentPlayer) {
            console.log('Current player not found:', currentPlayerId);
            return;
        }

        const allStatements = [
            ...currentPlayer.statements.truths,
            currentPlayer.statements.lie
        ];

        const shuffledStatements = [...allStatements].sort(() => 0.5 - Math.random());

        this.currentStatementMapping = shuffledStatements.map(statement => {
            if (statement === currentPlayer.statements.lie) {
                return 'lie';
            } else {
                return 'truth';
            }
        });

        this.broadcastToAll({
            type: 'round_started',
            round: this.currentRound,
            totalRounds: this.roundsCount,
            currentPlayerId: currentPlayerId,
            currentPlayerName: currentPlayer.name,
            statements: shuffledStatements,
            answerTime: this.answerTime
        });

        this.gameEvents.push({
            type: 'round_started',
            time: new Date().toISOString(),
            round: this.currentRound,
            playerId: currentPlayerId
        });
    }

    submitGuess(playerId, targetPlayerId, guessIndex) {
        let player;
        let isAdmin = false;

        if (playerId === 'admin') {
            isAdmin = true;
            player = {
                id: 'admin',
                name: this.adminName || 'Admin',
                teamId: this.adminTeamId
            };
            console.log('Admin is submitting a guess');

            if (this.adminScore === undefined) this.adminScore = 0;
            if (this.adminLieCorrectCount === undefined) this.adminLieCorrectCount = 0;
        } else {
            player = this.players.get(playerId);
            console.log('Player submitting guess:', player);

            if (!player) {
                return { success: false, error: 'Player not found' };
            }

            if (player.score === undefined) player.score = 0;
            if (player.lieCorrectCount === undefined) player.lieCorrectCount = 0;

            if (!player.guesses) player.guesses = {};
        }

        let targetStatements;
        let targetLieIndex;
        let targetName;

        if (targetPlayerId === 'admin') {
            const adminStatements = this.getAdminStatements();
            if (!adminStatements) {
                return { success: false, error: 'Admin statements not found' };
            }

            targetStatements = [...adminStatements.truths, adminStatements.lie];

            if (adminStatements.lieIndex === undefined) {
                targetLieIndex = adminStatements.truths.length; 
            } else {
                targetLieIndex = adminStatements.lieIndex;
            }

            console.log('Admin targetLieIndex:', targetLieIndex, 'Total statements:', targetStatements.length);
            targetName = this.adminName || 'Admin';
        } else {
            const targetPlayer = this.players.get(targetPlayerId);
            if (!targetPlayer) {
                return { success: false, error: 'Target player not found' };
            }

            if (!targetPlayer.statements || !targetPlayer.statements.truths || !targetPlayer.statements.lie) {
                return { success: false, error: 'Target player has no valid statements' };
            }

            targetStatements = [...targetPlayer.statements.truths, targetPlayer.statements.lie];

            if (targetPlayer.lieIndex === undefined) {
                targetLieIndex = targetPlayer.statements.truths.length;
            } else {
                targetLieIndex = targetPlayer.lieIndex;
            }

            console.log('Player targetLieIndex:', targetLieIndex, 'Total statements:', targetStatements.length);
            targetName = targetPlayer.name;
        }

        if (!this.gameStarted || this.gamePhase !== 'guessing') {
            return { success: false, error: 'Game is not in guessing phase' };
        }

        if (guessIndex < 0 || guessIndex >= targetStatements.length) {
            return { success: false, error: 'Invalid guess index' };
        }

        if (playerId === 'admin') {
            if (!this.adminGuesses) {
                this.adminGuesses = {};
            }
            this.adminGuesses[targetPlayerId] = guessIndex;
        } else {
            player.guesses[targetPlayerId] = guessIndex;
        }

        let lieShuffledIndex = this.currentLieShuffledIndex;
        console.log('Using shuffled lie index for validation:', lieShuffledIndex);

        let isCorrect;

        const targetPlayer = targetPlayerId === 'admin' ? 'admin' : this.players.get(targetPlayerId);

        if (targetPlayerId === 'admin') {
            if (this.adminGuessesReceived === undefined) this.adminGuessesReceived = 0;
            if (this.adminSuccessfulDeceptions === undefined) this.adminSuccessfulDeceptions = 0;

            this.adminGuessesReceived++;
        } else if (targetPlayer) {
            if (targetPlayer.guessesReceived === undefined) targetPlayer.guessesReceived = 0;
            if (targetPlayer.successfulDeceptions === undefined) targetPlayer.successfulDeceptions = 0;

            targetPlayer.guessesReceived++;
        }

        console.log('Debug - Statement validation:', {
            playerId,
            targetPlayerId,
            guessIndex,
            originalLieIndex: targetLieIndex,
            shuffledLieIndex: lieShuffledIndex,
            questionType: this.currentQuestionType,
            targetStatements: targetStatements ? targetStatements.length : 0
        });

        if (this.currentQuestionType === 'truth') {
            isCorrect = lieShuffledIndex !== guessIndex;

            if (isCorrect) {
                if (playerId === 'admin') {
                    this.adminScore++; 
                } else {
                    player.score++; 
                }
            }
        } else {
            isCorrect = lieShuffledIndex === guessIndex;

            if (isCorrect) {
                if (playerId === 'admin') {
                    this.adminScore++; 
                    this.adminLieCorrectCount++; 
                } else {
                    player.score++; 
                    player.lieCorrectCount++; 
                }
            }
            else {
                if (targetPlayerId === 'admin') {
                    this.adminSuccessfulDeceptions++;
                    console.log(`Admin deceived player ${playerId}! adminSuccessfulDeceptions=${this.adminSuccessfulDeceptions}, adminGuessesReceived=${this.adminGuessesReceived}`);
                } else if (targetPlayer) {
                    targetPlayer.successfulDeceptions++;
                    console.log(`Player ${targetPlayerId} deceived player ${playerId}! successfulDeceptions=${targetPlayer.successfulDeceptions}, guessesReceived=${targetPlayer.guessesReceived}`);
                }
            }
        }

        console.log(`Player ${playerId} guessed statement ${guessIndex} as a ${this.currentQuestionType}. ` +
                   `Actual lie index (shuffled): ${lieShuffledIndex}. Guess is ${isCorrect ? 'correct' : 'incorrect'}.`);

        if (isCorrect && this.teamMode !== 'allVsAll') {
            if (!this.teamScores) {
                this.teamScores = {};
            }

            if (playerId === 'admin' && this.adminTeamId) {
                if (!this.teamScores[this.adminTeamId]) {
                    this.teamScores[this.adminTeamId] = 0;
                }
            } else if (player.teamId) {
                if (!this.teamScores[player.teamId]) {
                    this.teamScores[player.teamId] = 0;
                }
            }
        }

        const truthIndices = [];
        for (let i = 0; i < targetStatements.length; i++) {
            if (i !== targetLieIndex) {
                truthIndices.push(i);
            }
        }

        const updatedScores = this.getScores();

        this.broadcastToAll({
            type: 'player_guessed',
            playerId: playerId,
            name: player.name || (playerId === 'admin' ? (this.adminName || 'Admin') : 'Unknown Player'),
            targetPlayerId: targetPlayerId,
            targetName: targetName,
            guessIndex: guessIndex,
            isCorrect: isCorrect,
            scores: updatedScores,
            truthIndices: truthIndices,
            lieIndex: targetLieIndex,
            questionType: this.currentQuestionType
        });

        this.gameEvents.push({
            type: 'guess_submitted',
            time: new Date().toISOString(),
            playerId: playerId,
            playerName: player.name || (playerId === 'admin' ? (this.adminName || 'Admin') : 'Unknown Player'),
            targetPlayerId: targetPlayerId,
            targetName: targetName,
            guessIndex: guessIndex,
            isCorrect: isCorrect,
            questionType: this.currentQuestionType
        });

        return {
            success: true,
            isCorrect: isCorrect,
            correctIndex: guessIndex,
            truthIndices: truthIndices,
            lieIndex: targetLieIndex,
            questionType: this.currentQuestionType,
            scores: updatedScores 
        };
    }

    advanceRound() {
        this.currentRound++;
        this.startNewRound();
    }

    sendToAll(data) {
        this.sendToAdmin(data);

        this.players.forEach((player, playerId) => {
            this.sendToPlayer(playerId, data);
        });
    }

    broadcastGameState(targetPlayerId = null) {
        const baseGameState = {
            type: 'game_state',
            gamePhase: this.gamePhase,
            gameStarted: this.gameStarted,
            gameEnded: this.gameEnded,
            currentRound: this.currentRound,
            roundsCount: this.roundsCount,
            answerTime: this.answerTime,
            teamMode: this.teamMode,
            adminName: this.adminName,
            statusMessage: this.statusMessage,
            statusIsReady: this.statusIsReady,
            questionType: this.currentQuestionType, 
            players: Array.from(this.players.entries()).map(([id, player]) => ({
                id,
                name: player.name,
                teamId: player.teamId,
                teamName: player.teamId > 0 ? this.teamNames.get(player.teamId) : null,
                ready: player.ready || false,
                submittedStatements: player.submittedStatements || false
            })),
            teams: this.getTeamsForBroadcast(),
            teamNames: Object.fromEntries(this.teamNames),
            scores: this.getScores()
        };

        const countdownInfo = this.getCountdownInfo();
        if (countdownInfo.inCountdown || this.gamePhase === 'countdown') {
            baseGameState.countdown = countdownInfo;
        }

        if (this.gamePhase === 'guessing' && this.currentGuessingPlayerId) {
            if (this.currentGuessingPlayerId === 'admin') {
                const adminStatements = this.getAdminStatements();
                if (adminStatements) {
                    baseGameState.currentGuessingPlayer = {
                        playerId: 'admin',
                        name: this.adminName || 'Admin',
                        teamId: this.adminTeamId,
                        teamName: this.adminTeamId > 0 ? this.teamNames.get(this.adminTeamId) : null,
                        statements: this.preparePlayerStatementsForGuessing(adminStatements),
                        questionType: this.currentQuestionType 
                    };
                }
            } else {
                const currentPlayer = this.players.get(this.currentGuessingPlayerId);
                if (currentPlayer && currentPlayer.statements) {
                    baseGameState.currentGuessingPlayer = {
                        playerId: this.currentGuessingPlayerId,
                        name: currentPlayer.name,
                        teamId: currentPlayer.teamId,
                        teamName: currentPlayer.teamId > 0 ? this.teamNames.get(currentPlayer.teamId) : null,
                        statements: this.preparePlayerStatementsForGuessing(currentPlayer.statements),
                        questionType: this.currentQuestionType 
                    };
                }
            }
        }

        if (targetPlayerId) {
            const playerData = this.players.get(targetPlayerId);
            if (playerData) {
                const playerGameState = {
                    ...baseGameState,
                    myStatements: playerData.statements || [],
                    myGuesses: playerData.guesses || {}
                };
                this.sendToPlayer(targetPlayerId, playerGameState);
            }
        } else {
            const adminGameState = {
                ...baseGameState,
                teamId: this.adminTeamId,
                teamName: this.adminTeamId > 0 ? this.teamNames.get(this.adminTeamId) : 'Admin Team',
                allPlayerStatements: Array.from(this.players.entries())
                    .filter(([id, player]) => player.statements && player.statements.length > 0)
                    .map(([id, player]) => ({
                        playerId: id,
                        name: player.name,
                        statements: player.statements,
                        lieIndex: player.lieIndex
                    })),
                readyPlayers: Array.from(this.readyPlayers),
                currentPlayerIndex: this.currentPlayerIndex,
                roundTimer: this.roundTimer
            };
            this.sendToAdmin(adminGameState);

            this.players.forEach((player, playerId) => {
                if (!player.socket || player.socket.readyState !== WebSocket.OPEN) return;

                const playerGameState = {
                    ...baseGameState,
                    myStatements: player.statements || [],
                    myGuesses: player.guesses || {}
                };

                if (this.gamePhase === 'guessing' && this.currentPlayerIndex !== null) {
                    const currentPlayer = this.getCurrentRoundPlayer();
                    if (currentPlayer) {
                        playerGameState.currentPlayerStatements = {
                            playerId: this.getCurrentRoundPlayerId(),
                            name: currentPlayer.name,
                            statements: currentPlayer.statements
                        };
                    }
                }

                this.sendToPlayer(playerId, playerGameState);
            });
        }
    }

    getCurrentRoundPlayer() {
        if (this.currentPlayerIndex === null) return null;
        const playerIds = Array.from(this.players.keys());
        if (this.currentPlayerIndex >= playerIds.length) return null;
        return this.players.get(playerIds[this.currentPlayerIndex]);
    }

    getCurrentRoundPlayerId() {
        if (this.currentPlayerIndex === null) return null;
        const playerIds = Array.from(this.players.keys());
        if (this.currentPlayerIndex >= playerIds.length) return null;
        return playerIds[this.currentPlayerIndex];
    }

    initializeGuessingPhase(answerTime = 10) {
        console.log(`Initializing guessing phase with ${answerTime}s per round`);

        this.answerTime = answerTime;

        this.playerOrder = Array.from(this.players.keys());

        const adminStatements = this.getAdminStatements();
        if (adminStatements && adminStatements.truths && adminStatements.lie) {
            this.playerOrder.push('admin');
            console.log('Added admin to the player rotation for guessing phase');
        }

        this.playerOrder = this.shuffleArray(this.playerOrder);

        this.currentPlayerIndex = 0;

        this.currentGuessingPlayerId = this.playerOrder[0];

        this.startGuessingRound();
    }

    getAdminStatements() {
        if (!this.adminStatements || !this.adminStatements.truths || !this.adminStatements.lie) {
            console.log('Admin statements not properly set:', this.adminStatements);
            return null;
        }
        return this.adminStatements;
    }

    startGuessingRound() {
        const currentPlayerId = this.playerOrder[this.currentPlayerIndex];
        this.currentGuessingPlayerId = currentPlayerId;

        this.currentQuestionType = Math.random() < 0.5 ? 'truth' : 'lie';
        console.log(`This guessing round asks players to select a ${this.currentQuestionType}`);

        if (this.currentQuestionType === 'lie') {
            if (this.lieRoundsTotal === undefined) this.lieRoundsTotal = 0;
            this.lieRoundsTotal++;
        }

        let statements;
        let playerName;

        if (currentPlayerId === 'admin') {
            statements = this.getAdminStatements();
            playerName = this.adminName || 'Admin';

            if (!statements || !statements.truths || statements.truths.length !== 2 || !statements.lie) {
                console.log('No valid statements found for admin, moving to next player');
                return;
            }
        } else {
            const player = this.players.get(currentPlayerId);

            if (!player || !player.statements || !player.statements.truths) {
                console.log(`No valid statements found for player ${currentPlayerId}, moving to next player`);
                return;
            }

            statements = player.statements;
            playerName = player.name;
        }

        const shuffledStatements = this.preparePlayerStatementsForGuessing(statements);

        this.startCountdown(this.answerTime, 'perGuess');

        const teamId = currentPlayerId === 'admin' ? this.adminTeamId : this.players.get(currentPlayerId).teamId;
        const teamName = teamId > 0 ? this.teamNames.get(teamId) : null;

        const currentPlayerInfo = {
            playerId: currentPlayerId,
            name: playerName,
            teamId: teamId,
            teamName: teamName,
            statements: shuffledStatements
        };

        this.broadcast({
            type: 'current_player_statements',
            currentPlayer: currentPlayerInfo,
            answerTime: this.answerTime,
            currentPlayerIndex: this.currentPlayerIndex,
            totalPlayers: this.playerOrder.length,
            countdown: this.getCountdownInfo(),
            questionType: this.currentQuestionType 
        });

        this.broadcastGameState();

        this.scheduleCountdownCompletion(this.answerTime, () => {
            this.moveToNextPlayer();
        });

        console.log(`Started guessing round for player ${playerName} (${currentPlayerId}) with ${this.answerTime}s timer`);
    }

    preparePlayerStatementsForGuessing(statementsObj) {
        let statements = [];

        for (let i = 0; i < statementsObj.truths.length; i++) {
            statements.push({
                originalIndex: statements.length, 
                text: statementsObj.truths[i],
                isLie: false 
            });
        }

        if (statementsObj.lie) {
            statements.push({
                originalIndex: statements.length, 
                text: statementsObj.lie,
                isLie: true 
            });
        }

        statements = this.shuffleArray(statements);

        for (let i = 0; i < statements.length; i++) {
            if (statements[i].isLie) {
                this.currentLieShuffledIndex = i;
                break;
            }
        }

        console.log(`After shuffling, lie is at position ${this.currentLieShuffledIndex}`);

        return statements.map((s, index) => ({
            index: index, 
            text: s.text
        }));
    }

    moveToNextPlayer() {
        this.currentPlayerIndex++;

        this.currentRound = this.currentPlayerIndex + 1;

        if (this.currentPlayerIndex >= this.playerOrder.length) {
            console.log('All players have been guessed, moving to results');

            this.endGuessingPhase();
            return;
        }

        console.log(`Moving to round ${this.currentRound} (player ${this.currentPlayerIndex+1} of ${this.playerOrder.length})`);


        setTimeout(() => {
            this.startGuessingRound();
        }, 1000);
    }

    endGuessingPhase() {
        this.gamePhase = 'results';
        this.inCountdown = false;
        this.gameStarted = false; 

        this.calculateFinalScores();

        console.log('Final scores:', JSON.stringify(Object.fromEntries(this.scores)));

        this.broadcastGameState();

        console.log('Guessing phase ended, transitioned to results');
    }

    shuffleArray(array) {
        const newArray = [...array];
        for (let i = newArray.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
        }
        return newArray;
    }

    calculateFinalScores() {
        console.log('Calculating final scores');

        this.scores.clear();

        if (this.teamMode !== 'allVsAll') {
            this.teams.forEach((players, teamId) => {
                let teamScore = 0;

                players.forEach(playerId => {
                    const player = this.players.get(playerId);
                    if (player && player.guesses) {
                        Object.entries(player.guesses).forEach(([targetId, guessIndex]) => {
                            const targetPlayer = this.players.get(targetId);
                            if (targetPlayer && targetPlayer.statements) {
                                const isCorrect = guessIndex === this.findLieIndex(targetPlayer.statements);
                                if (isCorrect) {
                                    teamScore += 1;
                                }
                            }
                        });
                    }
                });

                this.scores.set(teamId, teamScore);
            });
        } else {
            this.players.forEach((player, playerId) => {
                let playerScore = 0;

                if (player.guesses) {
                    Object.entries(player.guesses).forEach(([targetId, guessIndex]) => {
                        const targetPlayer = this.players.get(targetId);
                        if (targetPlayer && targetPlayer.statements) {
                            const isCorrect = guessIndex === this.findLieIndex(targetPlayer.statements);
                            if (isCorrect) {
                                playerScore += 1;
                            }
                        }
                    });
                }

                this.scores.set(playerId, playerScore);
            });
        }

        console.log('Final scores:', Object.fromEntries(this.scores));
    }

    findLieIndex(statements) {
        if (!statements || !statements.lie) return -1;

        const allStatements = [];

        if (statements.truths && Array.isArray(statements.truths)) {
            statements.truths.forEach(truth => allStatements.push({ text: truth, isLie: false }));
        }

        allStatements.push({ text: statements.lie, isLie: true });

        return allStatements.findIndex(s => s.isLie === true);
    }

    sendGameLogs() {
        if (this.enableTeamPlayLogging && process.env.TEAMPLAY_API_TOKEN) {
            const gameLog = {
                game_code: this.gameCode,
                api_code: this.apiCode,
                game_events: this.gameEvents
            };

            const options = {
                hostname: 'admin.team-play.online',
                path: '/api/save-game-log',
                method: 'POST',
                headers: {
                    'Authorization': process.env.TEAMPLAY_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode === 201) {
                        console.log('Successfully sent game log to TeamPlay API');
                    } else {
                        console.error('Failed to send game log to TeamPlay API:', res.statusCode, data);
                    }
                });
            });

            req.on('error', (error) => {
                console.error('Error sending game log to TeamPlay API:', error);
            });

            req.write(JSON.stringify({
                game_session_code: this.apiCode,
                log_data: gameLog
            }));
            req.end();
        } else {
            console.log('TeamPlay API logging is disabled');
        }

        this.gameEvents = [];
    }


}

wss.on('connection', (ws) => {
    console.log('New connection established');

    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    clients.set(ws, {
        type: null,
        gameCode: null,
        playerId: null
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const clientInfo = clients.get(ws);

            switch(data.type) {
                case 'reset_session':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const currentGame = activeGames.get(clientInfo.gameCode);
                        if (currentGame) {
                            currentGame.resetSession();
                        }
                    }
                    break;

                case 'set_admin_info':
                case 'admin_name_update':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            const adminName = data.type === 'admin_name_update' ? data.name : data.adminName;
                            game.setAdminInfo(adminName);
                            console.log(`Admin name updated to: ${adminName}`);
                        }
                    }
                    break;

                case 'admin_team_update':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            console.log(`Admin team update received: ${data.teamId}`);
                            game.adminTeamId = data.teamId;
                            game.broadcastGameState();
                            console.log(`Admin team updated to: ${data.teamId}`);
                        }
                    }
                    break;

                case 'set_team_mode':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            const result = game.setTeamMode(data.mode);
                            if (!result.success) {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: result.error
                                }));
                            }
                        }
                    }
                    break;

                case 'assign_teams':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            const result = game.assignTeams();
                            if (!result.success) {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: result.error
                                }));
                            }
                        }
                    }
                    break;

                case 'assign_player_to_team':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            const result = game.assignPlayerToTeam(data.playerId, data.teamId);
                            if (!result.success) {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: result.error
                                }));
                            }
                        }
                    }
                    break;

                case 'submit_statements':
                    if (clientInfo && (clientInfo.type === 'player' || clientInfo.type === 'admin')) {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            const playerId = clientInfo.type === 'admin' ? 'admin' : clientInfo.playerId;
                            const result = game.submitStatements(playerId, data.statements);

                            if (!result.success) {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: result.error
                                }));
                            }
                        }
                    }
                    break;

                case 'player_ready':
                    if (clientInfo && clientInfo.type === 'player') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            game.setPlayerReady(clientInfo.playerId, data.ready);
                        }
                    }
                    break;

                case 'create_session':
                    const gameCode = data.gameCode || uuidv4();
                    let existingGame = activeGames.get(gameCode);

                    if (existingGame && existingGame.admin && existingGame.admin.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            code: 'ADMIN_EXISTS',
                            message: 'An admin window is already open for this game. Please use the existing window or close it first.'
                        }));
                        return;
                    }

                    const gamesWithSameApiCode = Array.from(activeGames.values())
                        .filter(game => game.apiCode === data.apiCode && game.admin && game.admin.readyState === WebSocket.OPEN);

                    if (gamesWithSameApiCode.length > 0) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            code: 'ADMIN_EXISTS',
                            message: 'You already have an active admin window open. Please use that window or close it first.'
                        }));
                        ws.close();
                        return;
                    }

                    if (existingGame) {
                        existingGame.admin = ws;
                    } else {
                        existingGame = new Game(ws, gameCode);
                        existingGame.apiValidated = false;

                        ws.send(JSON.stringify({
                            type: 'session_created',
                            sessionId: gameCode
                        }));
                    }

                    console.log('Sending example statements');
                    ws.send(JSON.stringify({
                        type: 'example_statements',
                        examples: config.exampleStatements
                    }));

                    if (data.apiCode) {
                        const validation = config.enableApiValidation
                            ? await validateApiCode(data.apiCode)
                            : { valid: true };
                        if (!validation.valid) {
                            console.log('API validation failed:', validation.error);
                            existingGame.apiValidated = false;
                            existingGame.apiCode = null;
                            ws.send(JSON.stringify({
                                type: 'error',
                                code: 'API_ERROR',
                                message: validation.error
                            }));
                            existingGame.players.forEach((player) => {
                                player.socket.send(JSON.stringify({
                                    type: 'error',
                                    code: 'API_ERROR',
                                    message: 'Game session requires API validation. Please wait for the admin to fix this.'
                                }));
                            });
                            return;
                        }
                        existingGame.apiValidated = true;
                        existingGame.apiCode = data.apiCode;

                        existingGame.players.forEach((player) => {
                            player.socket.send(JSON.stringify({
                                type: 'api_validated',
                                validated: true
                            }));
                        });
                    } else {
                        existingGame.apiValidated = false;
                        ws.send(JSON.stringify({
                            type: 'error',
                            code: 'API_ERROR',
                            message: 'API code is required to create or join a game session.'
                        }));
                        existingGame.players.forEach((player) => {
                            player.socket.send(JSON.stringify({
                                type: 'error',
                                code: 'API_ERROR',
                                message: 'Game session requires API validation. Please wait for the admin to fix this.'
                            }));
                        });
                        return;
                    }

                    existingGame.admin = ws;

                    ws.send(JSON.stringify({
                        type: 'session_created',
                        sessionId: gameCode
                    }));

                    existingGame.broadcastGameState();

                    clients.set(ws, { type: 'admin', gameCode: gameCode });
                    break;

                case 'join_session':
                    console.log(data);
                    const targetGame = activeGames.get(data.sessionId);
                    if (targetGame) {
                        if (!targetGame.apiValidated) {
                            ws.send(JSON.stringify({
                                type: 'error',
                                code: 'API_ERROR',
                                message: 'This game session requires API validation. Please contact the game admin.'
                            }));
                            return;
                        }

                        console.log('Join session data received:', data);
                        if (data.playerId) {
                            console.log('Reconnection attempt with playerId:', data.playerId);
                            console.log('Current players in game:', Array.from(targetGame.players.keys()));
                            const existingPlayer = targetGame.players.get(data.playerId);
                            if (existingPlayer) {
                                console.log('Found existing player:', {
                                    playerId: data.playerId,
                                    name: existingPlayer.name,
                                    color: existingPlayer.color
                                });
                                existingPlayer.socket = ws;
                                clients.set(ws, {
                                    type: 'player',
                                    gameCode: data.sessionId,
                                    playerId: data.playerId
                                });

                                ws.send(JSON.stringify({
                                    type: 'joined_game',
                                    playerId: data.playerId,
                                    teamId: existingPlayer.teamId,
                                    gamePhase: targetGame.gamePhase,
                                    teamMode: targetGame.teamMode,
                                    statements: existingPlayer.statements,
                                    exampleStatements: config.exampleStatements
                                }));

                                if (targetGame.gamePhase === 'guessing' || targetGame.gamePhase === 'results') {
                                    ws.send(JSON.stringify({
                                        type: 'game_started',
                                        currentRound: targetGame.currentRound,
                                        totalRounds: targetGame.roundsCount,
                                        answerTime: targetGame.answerTime
                                    }));
                                }

                                console.log('Player reconnected successfully');
                            } else {
                                console.log('Player ID not found in game players:', data.playerId);
                                console.log('Attempting to use provided ID for new player');
                                const success = targetGame.addPlayer(ws, data.name, data.playerId, data.color);
                                if (!success) {
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        message: 'Already in another game or game is full'
                                    }));
                                }
                            }
                        } else {
                            console.log('New player connection (no playerId provided)');
                            const success = targetGame.addPlayer(ws, data.name);
                            if (!success) {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: 'Already in another game or game is full'
                                }));
                            }
                        }
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Server was restarted. Please refresh the page to join a new game.',
                            code: 'SERVER_RESTART'
                        }));
                    }
                    break;

                case 'start_game':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            if (data.adminStatements) {
                                game.submitStatements('admin', data.adminStatements);
                            }

                            const settings = {
                                answerTime: data.answerTime,
                                roundsCount: data.roundsCount
                            };
                            const result = game.startGame(settings);
                            console.log(result, 123);

                            if (!result.success) {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: result.error
                                }));
                            } else {
                                const countdownSeconds = data.countdownSeconds || 5;

                                const answerTime = data.answerTime || 10;

                                const countdownInfo = game.startCountdown(countdownSeconds, 'gameStart');

                                game.broadcast({
                                    type: 'countdown_started',
                                    gamePhase: 'countdown',
                                    countdown: countdownInfo
                                });

                                game.sendToAdmin({
                                    type: 'countdown_started',
                                    gamePhase: 'countdown',
                                    countdown: countdownInfo
                                });

                                game.scheduleCountdownCompletion(countdownSeconds, () => {
                                    game.gamePhase = 'guessing';

                                    game.initializeGuessingPhase(answerTime);

                                    game.broadcastGameState();

                                    console.log(`Transitioned to guessing phase after ${countdownSeconds}s countdown`);
                                });
                            }
                        }
                    }
                    break;

                case 'finish_game':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game && game.gameStarted) {
                            if (game.countdownTimer) {
                                clearTimeout(game.countdownTimer);
                                game.countdownTimer = null;
                            }

                            if (game.guessingRoundTimer) {
                                clearTimeout(game.guessingRoundTimer);
                                game.guessingRoundTimer = null;
                            }

                            game.endGuessingPhase();

                            console.log('Game finished early by admin');
                        }
                    }
                    break;

                case 'submit_guess':
                    if (clientInfo) {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game && game.gameStarted && game.gamePhase === 'guessing') {
                            const playerId = clientInfo.type === 'admin' ? 'admin' : clientInfo.playerId;
                            const result = game.submitGuess(playerId, data.targetPlayerId, data.guessIndex);

                            ws.send(JSON.stringify({
                                type: 'guess_result',
                                success: result.success,
                                error: result.error,
                                isCorrect: result.isCorrect,
                                correctIndex: result.correctIndex
                            }));
                        }
                    }
                    break;

                case 'advance_round':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game && game.gameStarted) {
                            game.advanceRound();
                        }
                    }
                    break;

                case 'extend_timer':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game && game.gameStarted) {
                            game.broadcastToAll({
                                type: 'timer_extended',
                                additionalTime: data.seconds || 10
                            });
                        }
                    }
                    break;

                case 'game_status_message':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            game.statusMessage = data.message || '';
                            game.statusIsReady = data.isReady || false;

                            game.broadcastToAll({
                                type: 'game_status_message',
                                message: game.statusMessage,
                                isReady: game.statusIsReady
                            });

                        }
                    }
                    break;

                case 'play_again':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            game.resetSession();

                            game.broadcastToAll({
                                type: 'play_again'
                            });
                        }
                    }
                    break;

                case 'reset_game':
                    if (clientInfo && clientInfo.type === 'admin') {
                        const game = activeGames.get(clientInfo.gameCode);
                        if (game) {
                            game.resetSession();

                            game.broadcastToAll({
                                type: 'game_reset',
                                message: 'The game has been reset by the admin. Ready to start a new game.'
                            });

                            console.log(`Game ${clientInfo.gameCode} has been reset by admin`);
                        }
                    }
                    break;

                case 'api_validation_request':
                    const playerGame = getGameByPlayerId(ws.playerId);
                    if (playerGame) {
                        ws.send(JSON.stringify({
                            type: 'api_validated',
                            validated: playerGame.apiValidated
                        }));
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('error', () => {
        handleDisconnect(ws);
    });

    ws.on('close', () => {
        handleDisconnect(ws);
    });
});

function handleDisconnect(ws) {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
        const game = activeGames.get(clientInfo.gameCode);
        if (game) {
            if (clientInfo.type === 'admin') {
                game.admin = null;
                game.broadcast({
                    type: 'player_left',
                    playerId: 'admin',
                    name: 'Admin'
                });
            } else {
                console.log('Player disconnected:', clientInfo.playerId);
                game.removePlayer(clientInfo.playerId);
            }
        }
        clients.delete(ws);
    }
}

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            handleDisconnect(ws);
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

function getGameByPlayerId(playerId) {
    const gameCode = playerGames.get(playerId);
    return activeGames.get(gameCode);
}