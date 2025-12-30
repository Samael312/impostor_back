const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- IMPORTANTE: Asegúrate de que la carpeta 'data' y el archivo 'dictionaries.js' estén en GitHub ---
const {  DICTIONARIES, getRandomWord } = require('./data/dictionaries'); 

const app = express();
app.use(cors());

const server = http.createServer(app);

// --- CONFIGURACIÓN PARA RENDER ---
const io = new Server(server, {
  cors: {
    // "*" permite que cualquiera se conecte (útil para pruebas iniciales).
    // Cuando tengas tu frontend en Vercel, cambia "*" por ["https://tu-app.vercel.app", "http://localhost:5173"]
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// VARIABLES GLOBALES
const rooms = {}; 
let userCounter = 0; 

const generateRoomCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

io.on('connection', (socket) => {
  // --- 1. LOG PERSONALIZADO ---
  userCounter++;
  const randomId = Math.random().toString(36).substr(2, 5); 
  const customLogId = `Usuario${userCounter}_${randomId}`;
  
  socket.customLogId = customLogId; 
  console.log(`🟢 Conectado: ${customLogId}`);

  // --- 2. CREAR SALA (Con Configuración de Impostores) ---
  socket.on('create_room', ({ nickname, avatarConfig, settings }) => {
    const roomCode = generateRoomCode();
    
    // settings trae: { categories, maxPlayers, impostorCount }
    
    rooms[roomCode] = {
      players: [],
      gameStarted: false,
      hostId: socket.id,
      config: {
        maxPlayers: settings.maxPlayers || 10,
        allowedCategories: settings.categories || ['random'],
        // Guardamos cuántos impostores quiere el host
        impostorCount: settings.impostorCount || 1 
      }
    };

    const newPlayer = {
      id: socket.id,
      name: nickname,
      avatar: avatarConfig,
      isHost: true,
      score: 0
    };

    rooms[roomCode].players.push(newPlayer);
    socket.join(roomCode); 

    socket.emit('room_created', { 
        roomCode: roomCode,
        players: rooms[roomCode].players
    });
    console.log(`🏠 Sala ${roomCode} creada (Max: ${settings.maxPlayers}, Impostores: ${settings.impostorCount})`);
  });

  // --- 3. UNIRSE A SALA ---
  socket.on('join_room', ({ roomCode, nickname, avatarConfig }) => {
    const code = roomCode?.toUpperCase();

    if (!rooms[code]) {
      socket.emit('error_message', 'La sala no existe ❌');
      return;
    }
    if (rooms[code].gameStarted) {
      socket.emit('error_message', 'La partida ya empezó 🚫');
      return;
    }
    
    if (rooms[code].players.length >= rooms[code].config.maxPlayers) {
        socket.emit('error_message', '¡La sala está llena! 🌕');
        return;
    }

    const newPlayer = {
      id: socket.id,
      name: nickname,
      avatar: avatarConfig,
      isHost: false,
      score: 0
    };

    rooms[code].players.push(newPlayer);
    socket.join(code);

    io.to(code).emit('update_players', rooms[code].players);
    socket.emit('room_joined', { roomCode: code, players: rooms[code].players });

    console.log(`👋 ${customLogId} entró a sala ${code}`);
  });

  // --- 4. INICIAR PARTIDA (Lógica Multi-Impostor) ---
  socket.on('start_game', ({ roomCode }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];

    if (!room || room.hostId !== socket.id) return;
    
    // Validación mínima de jugadores
    if (room.players.length < 3) { 
        socket.emit('error_message', 'Mínimo 3 jugadores para empezar.');
        return;
    }

    // A. SELECCIONAR TEMA
    const availableCategories = room.config.allowedCategories;
    const randomCatKey = availableCategories[Math.floor(Math.random() * availableCategories.length)];
    
    const { word, category } = getRandomWord(randomCatKey);

    // B. SELECCIONAR IMPOSTORES
    const totalPlayers = room.players.length;
    let count = room.config.impostorCount || 1;

    // Seguridad: Que los impostores no sean más de la mitad
    const maxAllowed = Math.floor((totalPlayers - 1) / 2) || 1; 
    if (count > maxAllowed) count = maxAllowed;

    // Algoritmo de mezcla (Shuffle)
    const shuffledIds = room.players.map(p => p.id).sort(() => 0.5 - Math.random());
    const selectedImpostorIds = shuffledIds.slice(0, count);

    room.gameStarted = true;
    room.word = word;       
    room.impostorIds = selectedImpostorIds;
    room.categoryPlayed = category; 

    console.log(`🎮 Partida en ${code} | Tema: ${category} | Impostores: ${count}`);

    // C. ENVIAR ROLES A CADA JUGADOR
    room.players.forEach(player => {
      const isImpostor = selectedImpostorIds.includes(player.id);
      
      const secretPayload = {
        gameStarted: true,
        role: isImpostor ? 'impostor' : 'civil',
        word: isImpostor ? '???' : word,
        category: category,
        players: room.players,
        impostorCount: count 
      };
      
      io.to(player.id).emit('game_started', secretPayload);
    });
  });
  
  // --- 5. DESCONEXIÓN ---
  socket.on('disconnect', () => {
    console.log(`🔴 Desconectado: ${socket.customLogId || socket.id}`);
    for (const code in rooms) {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);
      
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) {
          delete rooms[code];
        } else {
          if (room.hostId === socket.id) {
             room.hostId = room.players[0].id;
             room.players[0].isHost = true;
          }
          io.to(code).emit('update_players', room.players);
        }
        break; 
      }
    }
  });
});

// --- AJUSTE DE PUERTO PARA RENDER ---
const PORT = process.env.PORT || 3001; // Render inyecta el puerto aquí
server.listen(PORT, () => {
  console.log(`🚀 BACKEND CORRIENDO EN PUERTO ${PORT}`);
});