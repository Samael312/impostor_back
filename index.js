const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Asegúrate de que este archivo existe y exporta { getRandomWord }
const { getRandomWord } = require('./data/dictionaries'); 

const app = express();
app.use(cors());

const server = http.createServer(app);

// --- CONFIGURACIÓN SOCKET.IO ---
const io = new Server(server, {
  cors: {
    // En producción (Vercel), cambia "*" por la URL de tu frontend
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// ALMACÉN EN MEMORIA (Volátil: se borra si reinicias el servidor)
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
    
    const maxPlayers = settings?.maxPlayers || 8;
    const impostorCount = settings?.impostorCount || 1;
    const categories = settings?.categories || ['random'];

    rooms[roomCode] = {
      players: [],
      gameStarted: false,
      hostId: socket.id,
      config: {
        maxPlayers,
        allowedCategories: categories,
        impostorCount
      }
    };

    const newPlayer = {
      id: socket.id,
      name: nickname || 'Jugador',
      avatar: avatarConfig,
      isHost: true,
      score: 0
    };

    rooms[roomCode].players.push(newPlayer);
    socket.join(roomCode); 

    socket.emit('room_created', { 
        roomCode,
        players: rooms[roomCode].players
    });
    console.log(`🏠 Sala ${roomCode} creada por ${nickname}`);
  });

  // --- 2. UNIRSE A SALA ---
  socket.on('join_room', ({ roomCode, nickname, avatarConfig }) => {
    const code = roomCode?.toUpperCase();

    if (!rooms[code]) {
      socket.emit('error_message', 'La sala no existe ❌');
      return;
    }
    // Si la partida ya empezó, no dejamos entrar (o podrías manejar reconexión aquí)
    if (rooms[code].gameStarted) {
      socket.emit('error_message', 'La partida ya empezó 🚫');
      return;
    }
    
    if (rooms[code].players.length >= rooms[code].config.maxPlayers) {
        socket.emit('error_message', '¡La sala está llena! 🌕');
        return;
    }

    const nameExists = rooms[code].players.some(p => p.name === nickname);
    const safeName = nameExists ? `${nickname} (2)` : nickname;

    const newPlayer = {
      id: socket.id,
      name: safeName,
      avatar: avatarConfig,
      isHost: false,
      score: 0
    };

    rooms[code].players.push(newPlayer);
    socket.join(code);

    io.to(code).emit('update_players', rooms[code].players);
    socket.emit('room_joined', { roomCode: code, players: rooms[code].players });

    console.log(`👋 ${nickname} entró a ${code}`);
  });

  // --- 3. INICIAR PARTIDA ---
  socket.on('start_game', ({ roomCode }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];

    if (!room || room.hostId !== socket.id) return;
    
    if (room.players.length < 3) { 
        socket.emit('error_message', 'Se necesitan mínimo 3 jugadores.');
        return;
    }

    // A. SELECCIONAR PALABRA
    const availableCats = room.config.allowedCategories; 
    let categoryToUse = 'random';
    if (availableCats.length > 0 && !availableCats.includes('random')) {
        categoryToUse = availableCats[Math.floor(Math.random() * availableCats.length)];
    }

    const { word, category } = getRandomWord(categoryToUse);

    // B. SELECCIONAR IMPOSTORES
    const totalPlayers = room.players.length;
    let desiredImpostors = room.config.impostorCount;

    const maxImpostors = Math.floor((totalPlayers - 1) / 2);
    if (desiredImpostors > maxImpostors) desiredImpostors = maxImpostors;
    if (desiredImpostors < 1) desiredImpostors = 1;

    const shuffledIds = room.players.map(p => p.id).sort(() => 0.5 - Math.random());
    const selectedImpostorIds = shuffledIds.slice(0, desiredImpostors);

    room.gameStarted = true;
    room.currentWord = word;        
    room.impostorIds = selectedImpostorIds;

    console.log(`🎮 Start ${code}: ${word} (${category}) | Impostores: ${desiredImpostors}`);

    // C. DISTRIBUIR ROLES
    room.players.forEach(player => {
      const isImpostor = selectedImpostorIds.includes(player.id);
      
      const secretPayload = {
        gameStarted: true,
        roundId: Date.now(), // <--- AGREGA ESTA LÍNEA (Genera un ID único por tiempo)
        role: isImpostor ? 'impostor' : 'jugador', 
        location: isImpostor ? '???' : word, 
        category: category,
        players: room.players,
        impostorCount: desiredImpostors 
      };
      
      io.to(player.id).emit('game_started', secretPayload);
    });
  });

  // --- 5. INICIAR DEBATE (VERSIÓN ROBUSTA) ---
  socket.on('start_debate', ({ roomCode }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];

    if (room && room.players) {
        // Enviar a cada jugador individualmente para asegurar que llegue a todos
        room.players.forEach(player => {
            io.to(player.id).emit('debate_started');
        });
        console.log(`🗣️ Debate iniciado en sala ${code} (Enviado a ${room.players.length} jugadores)`);
    } else {
        // Fallback
        io.to(code).emit('debate_started');
    }
  });

  // --- 4. DESCONEXIÓN ---
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);
      
      if (index !== -1) {
        const wasHost = room.players[index].isHost;
        room.players.splice(index, 1);

        if (room.players.length === 0) {
          delete rooms[code];
          console.log(`🗑️ Sala ${code} eliminada (vacía)`);
        } else {
          if (wasHost) {
             room.players[0].isHost = true;
             room.hostId = room.players[0].id;
          }
          io.to(code).emit('update_players', room.players);
        }
        break;
      }
    }
  });

  socket.on('disconnect_game', () => {
    socket.disconnect(); 
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 SERVIDOR LISTO EN PUERTO ${PORT}`);
});