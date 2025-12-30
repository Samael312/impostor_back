const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// CONFIGURACIÓN DE SOCKET.IO
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173", 
    methods: ["GET", "POST"]
  }
});

// --- BASE DE DATOS EN MEMORIA ---
const rooms = {}; 

// --- UTILIDAD: Generar código de sala ---
const generateRoomCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// --- LÓGICA DE CONEXIÓN ---
io.on('connection', (socket) => {
  console.log(` Nuevo usuario conectado: ${socket.id}`);

  // 1. CREAR SALA
  socket.on('create_room', ({ nickname, avatarConfig }) => {
    const roomCode = generateRoomCode();
    
    // Inicializamos la sala
    rooms[roomCode] = {
      players: [],
      gameStarted: false,
      hostId: socket.id // Guardamos quién es el jefe
    };

    // Creamos el objeto del jugador anfitrión
    const newPlayer = {
      id: socket.id,
      name: nickname,
      avatar: avatarConfig,
      isHost: true,
      score: 0
    };

    // Lo metemos en la sala
    rooms[roomCode].players.push(newPlayer);
    socket.join(roomCode); 

    // Respondemos al cliente
    socket.emit('room_created', { roomCode, players: rooms[roomCode].players });
    console.log(`Sala ${roomCode} creada por ${nickname}`);
  });

  // 2. UNIRSE A SALA
  socket.on('join_room', ({ roomCode, nickname, avatarConfig }) => {
    const code = roomCode?.toUpperCase();

    // Validaciones
    if (!rooms[code]) {
      socket.emit('error_message', 'La sala no existe');
      return;
    }
    if (rooms[code].gameStarted) {
      socket.emit('error_message', 'La partida ya empezó');
      return;
    }

    // Crear al jugador invitado
    const newPlayer = {
      id: socket.id,
      name: nickname,
      avatar: avatarConfig,
      isHost: false,
      score: 0
    };

    rooms[code].players.push(newPlayer);
    socket.join(code);

    // AVISAR A TODOS (incluido el nuevo)
    io.to(code).emit('update_players', rooms[code].players);
    
    // Confirmación específica al que entró (para que navegue al lobby)
    socket.emit('room_joined', { roomCode: code, players: rooms[code].players });

    console.log(`👋 ${nickname} entró a la sala ${code}`);
  });

  // 3. DESCONEXIÓN (Si cierran la pestaña)
  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
    
    // Buscar en qué sala estaba y borrarlo
    for (const code in rooms) {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);
      
      if (index !== -1) {
        room.players.splice(index, 1); // Lo borramos
        
        // Si la sala queda vacía, se destruye
        if (room.players.length === 0) {
          delete rooms[code];
          console.log(`🗑️ Sala ${code} eliminada (vacía)`);
        } else {
          // Avisamos a los que quedan
          io.to(code).emit('update_players', room.players);
        }
        break; 
      }
    }
  });
});

// ARRANCAR EL SERVIDOR
server.listen(3001, () => {
  console.log('BACKEND CORRIENDO EN PUERTO 3001');
});