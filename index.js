const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- IMPORTAMOS EL DICCIONARIO ---
// Asegúrate de que la ruta sea correcta: backend/data/dictionaries.js
const { getRandomLocation } = require('./data/dictionaries'); 

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173", 
    methods: ["GET", "POST"]
  }
});

// BASE DE DATOS EN MEMORIA
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
  console.log(`Usuario conectado: ${socket.id}`);

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

    // CORRECCIÓN IMPORTANTE AQUÍ:
    // 1. Avisar a TODOS (update_players) para actualizar la lista visual
    io.to(code).emit('update_players', rooms[code].players);
    
    // 2. Avisar al que entra (room_joined) para que su navegador cambie de página
    socket.emit('room_joined', { roomCode: code, players: rooms[code].players });

    console.log(`${nickname} se unió a la sala ${code}`);
  });

  // 3. INICIAR PARTIDA
  socket.on('start_game', ({ roomCode, categoryId }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];

    // Validaciones de seguridad
    if (!room) return;
    if (room.hostId !== socket.id) return; // Solo el host inicia
    
    // OJO: Para pruebas puedes bajar esto a 2, pero lo ideal es 3
    if (room.players.length < 3) {
        socket.emit('error_message', 'Mínimo 3 jugadores para empezar.');
        return;
    }

    // Configurar datos de la partida
    const { location, category } = getRandomLocation(categoryId || 'random');
    const impostorIndex = Math.floor(Math.random() * room.players.length);
    const impostorId = room.players[impostorIndex].id;

    room.gameStarted = true;
    room.location = location;       
    room.impostorId = impostorId;   
    room.categoryPlayed = category; 

    console.log(`Partida iniciada en ${code}. Lugar: ${location}. Impostor: ${room.players[impostorIndex].name}`);

    // REPARTO DE ROLES SECRETO
    room.players.forEach(player => {
      const isImpostor = player.id === impostorId;
      
      const secretPayload = {
        gameStarted: true,
        role: isImpostor ? 'impostor' : 'civil',
        location: isImpostor ? '???' : location, // El impostor no ve el lugar
        category: category,
        players: room.players
      };

      // Enviamos el mensaje SOLO a ese socket específico
      io.to(player.id).emit('game_started', secretPayload);
    });
  });
  
  // 4. DESCONEXIÓN (CORREGIDO)
  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
    
    // Buscar en todas las salas y borrar al jugador
    for (const code in rooms) {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);
      
      if (index !== -1) {
        // Borrar jugador
        room.players.splice(index, 1);
        
        // Si la sala se vacía, la borramos
        if (room.players.length === 0) {
          delete rooms[code];
          console.log(`Sala ${code} eliminada (vacía)`);
        } else {
          // Si quedan jugadores, actualizamos su lista
          // Si el host se fue, asignamos uno nuevo (el primero de la lista)
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

server.listen(3001, () => {
  console.log('BACKEND LISTO CON DICCIONARIOS EN PUERTO 3001');
});