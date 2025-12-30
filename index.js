const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { getRandomWord } = require('./data/dictionaries'); 

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  // Tiempos altos para tolerar móviles en segundo plano
  pingTimeout: 60000, 
  pingInterval: 25000 
});

const rooms = {}; 

const generateRoomCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

io.on('connection', (socket) => {
  console.log(`🟢 Conexión: ${socket.id}`);

  // --- 1. CREAR SALA ---
  socket.on('create_room', ({ nickname, avatarConfig, settings }) => {
    const roomCode = generateRoomCode();
    
    // Inicializamos la sala, PERO NO AGREGAMOS AL JUGADOR AÚN.
    // Esperamos a que el frontend haga 'join_room' inmediatamente después.
    rooms[roomCode] = {
      players: [],
      gameStarted: false,
      hostId: null, // Se asignará en join_room
      config: { 
        maxPlayers: settings?.maxPlayers || 10, 
        impostorCount: settings?.impostorCount || 1,
        allowedCategories: settings?.categories || ['random']
      },
      votes: {},
      impostorIds: [],
      currentWord: null,
      currentRoundId: null
    };

    socket.emit('room_created', { roomCode });
    console.log(`🏠 Sala ${roomCode} creada.`);
  });

  // --- 2. UNIRSE A SALA (LÓGICA UNIFICADA Y BLINDADA) ---
  socket.on('join_room', ({ roomCode, nickname, avatarConfig }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];

    if (!room) {
      socket.emit('error_message', 'La sala no existe ❌');
      return;
    }

    // A. RECONEXIÓN: ¿Ya existe alguien con este nombre?
    const existingPlayer = room.players.find(p => p.name === nickname);

    if (existingPlayer) {
        console.log(`♻️ RECONEXIÓN: ${nickname} en ${code}`);
        
        // Actualizamos socket ID
        const oldSocketId = existingPlayer.id;
        existingPlayer.id = socket.id; 
        existingPlayer.connected = true;
        if (avatarConfig) existingPlayer.avatar = avatarConfig;

        // Recuperar rol de Host si lo tenía
        if (existingPlayer.isHost) room.hostId = socket.id;

        socket.join(code);
        socket.currentRoom = code;
        
        // Avisar a todos
        io.to(code).emit('update_players', room.players);
        
        // SI LA PARTIDA YA EMPEZÓ: Restaurar estado
        if (room.gameStarted) {
            // Actualizar lista de impostores con el nuevo ID
            if (room.impostorIds.includes(oldSocketId)) {
                room.impostorIds = room.impostorIds.filter(id => id !== oldSocketId);
                room.impostorIds.push(socket.id);
            }
            const isImpostor = room.impostorIds.includes(socket.id);

            socket.emit('game_started', {
                gameStarted: true,
                roundId: room.currentRoundId,
                role: existingPlayer.role || (isImpostor ? 'impostor' : 'jugador'),
                location: isImpostor ? '???' : room.currentWord,
                category: room.categoryPlayed,
                players: room.players,
                impostorCount: room.config.impostorCount
            });
        }
        return;
    }

    // B. NUEVO JUGADOR
    if (room.gameStarted) {
      socket.emit('error_message', 'La partida ya empezó 🚫');
      return;
    }

    // Si es el primer jugador, es el Host
    const isFirst = room.players.length === 0;
    
    const newPlayer = {
      id: socket.id,
      name: nickname,
      avatar: avatarConfig,
      isHost: isFirst,
      score: 0,
      connected: true,
      role: null
    };

    if (isFirst) room.hostId = socket.id;

    room.players.push(newPlayer);
    socket.join(code);
    socket.currentRoom = code;

    console.log(`➕ ${nickname} entró a ${code}`);
    io.to(code).emit('update_players', room.players);
  });

  // --- 3. INICIAR PARTIDA ---
  socket.on('start_game', ({ roomCode, config }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];

    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) {
        socket.emit('error_message', 'Mínimo 3 jugadores requeridos.');
        return;
    }

    // Actualizar configuración si viene del Setup
    if (config) {
        if (config.categories) room.config.allowedCategories = config.categories;
        if (config.impostors) room.config.impostorCount = config.impostors;
    }

    // Elegir palabra
    const availableCats = room.config.allowedCategories; 
    let categoryToUse = 'random';
    if (availableCats.length > 0 && !availableCats.includes('random')) {
        categoryToUse = availableCats[Math.floor(Math.random() * availableCats.length)];
    }
    const { word, category } = getRandomWord(categoryToUse);

    // Elegir impostores
    const totalPlayers = room.players.length;
    let desiredImpostors = room.config.impostorCount;
    const maxImpostors = Math.floor((totalPlayers - 1) / 2);
    if (desiredImpostors > maxImpostors) desiredImpostors = maxImpostors;
    if (desiredImpostors < 1) desiredImpostors = 1;

    const shuffledIds = room.players.map(p => p.id).sort(() => 0.5 - Math.random());
    const selectedImpostorIds = shuffledIds.slice(0, desiredImpostors);

    // Guardar estado
    room.gameStarted = true;
    room.currentWord = word;
    room.categoryPlayed = category;
    room.impostorIds = selectedImpostorIds;
    room.currentRoundId = Date.now();
    room.votes = {};

    console.log(`🎮 Start ${code}: ${word} | Impostores: ${desiredImpostors}`);

    // Repartir roles
    room.players.forEach(player => {
      const isImpostor = selectedImpostorIds.includes(player.id);
      player.role = isImpostor ? 'impostor' : 'jugador';

      io.to(player.id).emit('game_started', {
        gameStarted: true,
        roundId: room.currentRoundId,
        role: player.role,
        location: isImpostor ? '???' : word,
        category: category,
        players: room.players,
        impostorCount: desiredImpostors
      });
    });
  });

  // --- 4. INICIAR DEBATE ---
  socket.on('start_debate', ({ roomCode }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];
    if (room && room.players) {
        room.votes = {}; 
        room.players.forEach(p => io.to(p.id).emit('debate_started'));
    }
  });

  // --- 5. VOTACIÓN ---
  socket.on('vote_player', ({ roomCode, votedId }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];
    if (!room || !room.gameStarted) return;

    room.votes[socket.id] = votedId;

    const totalVotes = Object.keys(room.votes).length;
    const activePlayers = room.players.filter(p => p.connected).length; // Solo contamos conectados

    console.log(`🗳️ Votos en ${code}: ${totalVotes}/${activePlayers}`);

    if (totalVotes >= activePlayers) {
        // Conteo
        const counts = {};
        let maxVotes = 0;
        let mostVotedId = null;
        let isTie = false;

        Object.values(room.votes).forEach(targetId => {
            counts[targetId] = (counts[targetId] || 0) + 1;
            if (counts[targetId] > maxVotes) {
                maxVotes = counts[targetId];
                mostVotedId = targetId;
                isTie = false;
            } else if (counts[targetId] === maxVotes) {
                isTie = true;
            }
        });

        // Lógica de Ganador
        const impostorCaught = !isTie && room.impostorIds.includes(mostVotedId);
        
        const results = {
            impostorCaught,
            mostVotedPlayer: room.players.find(p => p.id === mostVotedId) || null,
            impostors: room.players.filter(p => room.impostorIds.includes(p.id)),
            isTie,
            votesDetail: counts
        };

        room.players.forEach(p => io.to(p.id).emit('voting_results', results));
    }
  });

  // --- 6. SALIDA VOLUNTARIA ---
  socket.on('disconnect_game', () => {
    const code = socket.currentRoom;
    if (rooms[code]) {
        const pIndex = rooms[code].players.findIndex(p => p.id === socket.id);
        if (pIndex !== -1) {
            console.log(`👋 ${rooms[code].players[pIndex].name} salió.`);
            rooms[code].players.splice(pIndex, 1);
            
            if (rooms[code].players.length === 0) {
                delete rooms[code];
            } else {
                // Reasignar host si se fue el host
                if (!rooms[code].players.some(p => p.isHost)) {
                    rooms[code].players[0].isHost = true;
                    rooms[code].hostId = rooms[code].players[0].id;
                }
                io.to(code).emit('update_players', rooms[code].players);
            }
        }
    }
    socket.disconnect();
  });

  // --- 7. DESCONEXIÓN INVOLUNTARIA (NO BORRAR) ---
  socket.on('disconnect', () => {
    const code = socket.currentRoom;
    if (rooms[code]) {
        const player = rooms[code].players.find(p => p.id === socket.id);
        if (player) {
            console.log(`⚠️ ${player.name} desconectado (mantenemos sesión).`);
            player.connected = false;
            io.to(code).emit('update_players', rooms[code].players);
            // NO BORRAMOS. Así pueden reconectarse infinitamente.
        }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 SERVIDOR LISTO EN PUERTO ${PORT}`);
});