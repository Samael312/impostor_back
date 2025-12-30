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
    
    // Configuraciones por defecto si fallan los settings
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
    if (rooms[code].gameStarted) {
      socket.emit('error_message', 'La partida ya empezó 🚫');
      return;
    }
    
    if (rooms[code].players.length >= rooms[code].config.maxPlayers) {
        socket.emit('error_message', '¡La sala está llena! 🌕');
        return;
    }

    // Verificar si el nombre ya existe en la sala (opcional, pero recomendado)
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

    // Actualizar a todos en la sala
    io.to(code).emit('update_players', rooms[code].players);
    
    // Confirmar al usuario que se unió
    socket.emit('room_joined', { roomCode: code, players: rooms[code].players });

    console.log(`👋 ${nickname} entró a ${code}`);
  });

  // --- 3. INICIAR PARTIDA ---
  socket.on('start_game', ({ roomCode }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];

    if (!room || room.hostId !== socket.id) return;
    
    // Validación mínima (puedes cambiar a 3 para producción)
    if (room.players.length < 3) { 
        socket.emit('error_message', 'Se necesitan mínimo 3 jugadores.');
        return;
    }

    // A. SELECCIONAR PALABRA
    // Si hay varias categorías seleccionadas, elegimos una al azar de la lista permitida
    const availableCats = room.config.allowedCategories; 
    // Si availableCats tiene "random" o es vacio, getRandomWord maneja la lógica interna
    // Pero si el usuario eligió ["animales", "cosas"], elegimos una de esas dos primero
    let categoryToUse = 'random';
    if (availableCats.length > 0 && !availableCats.includes('random')) {
        categoryToUse = availableCats[Math.floor(Math.random() * availableCats.length)];
    }

    const { word, category } = getRandomWord(categoryToUse);

    // B. SELECCIONAR IMPOSTORES
    const totalPlayers = room.players.length;
    let desiredImpostors = room.config.impostorCount;

    // Calcular máximo seguro (si hay 4 jugadores, máx 1 impostor. Si hay 7, máx 3).
    const maxImpostors = Math.floor((totalPlayers - 1) / 2);
    if (desiredImpostors > maxImpostors) desiredImpostors = maxImpostors;
    if (desiredImpostors < 1) desiredImpostors = 1;

    // Mezclar jugadores y tomar los N primeros como impostores
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
        role: isImpostor ? 'impostor' : 'juagador',
        // IMPORTANTE: Enviamos 'word' bajo la clave 'location' para compatibilidad con Game.jsx
        location: isImpostor ? '???' : word, 
        category: category,
        players: room.players,
        impostorCount: desiredImpostors 
      };
      
      io.to(player.id).emit('game_started', secretPayload);
    });
  });

  // --- 5. INICIAR DEBATE (NUEVO) ---
  socket.on('start_debate', ({ roomCode }) => {
    const code = roomCode?.toUpperCase();
    
    // Avisar a TODOS en la sala (incluido el host) que cambien de pantalla
    io.to(code).emit('debate_started');
    
    console.log(`🗣️ Debate iniciado en sala ${code}`);
  });

  // --- 4. DESCONEXIÓN ---
  socket.on('disconnect', () => {
    // Buscar en qué sala estaba el socket desconectado
    for (const code in rooms) {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);
      
      if (index !== -1) {
        const wasHost = room.players[index].isHost;
        room.players.splice(index, 1); // Quitar jugador

        // Si la sala se queda vacía, borrarla
        if (room.players.length === 0) {
          delete rooms[code];
          console.log(`🗑️ Sala ${code} eliminada (vacía)`);
        } else {
          // Si se fue el host, asignar nuevo host al siguiente jugador
          if (wasHost) {
             room.players[0].isHost = true;
             room.hostId = room.players[0].id;
          }
          // Avisar a los demás
          io.to(code).emit('update_players', room.players);
        }
        break; // Salir del loop una vez encontrado
      }
    }
  });

  // Opcional: Manejo explícito de 'salir de la partida' desde el frontend
  socket.on('disconnect_game', () => {
    // Reutilizamos la lógica de desconexión forzando el evento
    socket.disconnect(); 
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 SERVIDOR LISTO EN PUERTO ${PORT}`);
});