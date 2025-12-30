const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const { getRandomWord } = require('./data/dictionaries'); 

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const rooms = {}; 
// Almacén para los temporizadores de desconexión (para evitar borrar gente por lag)
const disconnectTimers = {}; 

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
      config: { maxPlayers, allowedCategories: categories, impostorCount }
    };

    const newPlayer = {
      id: socket.id,
      name: nickname || 'Jugador',
      avatar: avatarConfig,
      isHost: true,
      score: 0,
      connected: true // Rastreamos estado de conexión
    };

    rooms[roomCode].players.push(newPlayer);
    socket.join(roomCode); 
    // Guardamos la sala en el socket para facilitar la desconexión
    socket.currentRoom = roomCode; 

    socket.emit('room_created', { 
        roomCode,
        players: rooms[roomCode].players
    });
    console.log(`🏠 Sala ${roomCode} creada por ${nickname}`);
  });

  // --- 2. UNIRSE A SALA (Con Lógica de Reconexión) ---
  socket.on('join_room', ({ roomCode, nickname, avatarConfig }) => {
    const code = roomCode?.toUpperCase();

    if (!rooms[code]) {
      socket.emit('error_message', 'La sala no existe ❌');
      return;
    }

    const room = rooms[code];
    // Buscamos si ya existe un jugador con ese nombre
    const existingPlayerIndex = room.players.findIndex(p => p.name === nickname);

    // --- ESCENARIO A: EL JUGADOR YA EXISTE (RECONEXIÓN) ---
    if (existingPlayerIndex !== -1) {
        const existingPlayer = room.players[existingPlayerIndex];

        // Si es el mismo usuario volviendo, actualizamos su Socket ID
        console.log(`♻️ ${nickname} se ha reconectado a ${code}`);
        
        // 1. Cancelar el temporizador de borrado si existía
        if (disconnectTimers[existingPlayer.id]) {
            clearTimeout(disconnectTimers[existingPlayer.id]);
            delete disconnectTimers[existingPlayer.id];
        }

        // 2. Actualizar ID y estado
        existingPlayer.id = socket.id; // Actualizamos al nuevo ID
        existingPlayer.connected = true;
        existingPlayer.avatar = avatarConfig; // Actualizamos avatar por si lo cambió
        
        // 3. Unir al socket a la sala
        socket.join(code);
        socket.currentRoom = code;

        // 4. Si era el host y perdió el rol, devolvérselo (opcional, simplificado aquí)
        if (existingPlayer.isHost) {
            room.hostId = socket.id;
        }

        // 5. Notificar a todos y enviar estado actual
        io.to(code).emit('update_players', room.players);
        socket.emit('room_joined', { roomCode: code, players: room.players });

        // SI LA PARTIDA YA EMPEZÓ, LE REENVIAMOS SU ROL
        if (room.gameStarted) {
             const isImpostor = room.impostorIds?.includes(socket.id) || room.impostorIds?.includes(existingPlayer.id); // Check robusto
             
             // Actualizamos lista de impostores con el nuevo ID si es necesario
             if (room.impostorIds && room.impostorIds.includes(existingPlayer.id)) {
                 // Reemplazar ID viejo por nuevo en la lista de impostores
                 // (Esto requeriría lógica extra si guardas IDs fijos, pero para este ejemplo simple basta con reenviar los datos)
             }

             // Reconstruir payload secreto (simplificado)
             // Nota: Para que esto sea perfecto, deberías guardar el 'role' en el objeto player también.
             // Aquí asumimos reinicio de vista simple:
             socket.emit('game_started', {
                gameStarted: true,
                role: 'recuperando...', // O idealmente guardar el rol en memory
                location: room.currentWord,
                category: 'Reconectado',
                players: room.players,
                isReconnection: true
             });
        }
        return;
    }

    // --- ESCENARIO B: JUGADOR NUEVO ---
    
    if (room.gameStarted) {
      socket.emit('error_message', 'La partida ya empezó 🚫');
      return;
    }
    
    if (room.players.length >= room.config.maxPlayers) {
        socket.emit('error_message', '¡La sala está llena! 🌕');
        return;
    }

    const newPlayer = {
      id: socket.id,
      name: nickname, // Ya no necesitamos agregar (2) porque manejamos la reconexión arriba
      avatar: avatarConfig,
      isHost: false,
      score: 0,
      connected: true
    };

    room.players.push(newPlayer);
    socket.join(code);
    socket.currentRoom = code;

    io.to(code).emit('update_players', room.players);
    socket.emit('room_joined', { roomCode: code, players: room.players });

    console.log(`👋 ${nickname} entró a ${code}`);
  });

  // --- 3. INICIAR PARTIDA ---
  socket.on('start_game', ({ roomCode, config }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms[code];

    if (!room || room.hostId !== socket.id) return;
    
    if (room.players.length < 3) { 
        socket.emit('error_message', 'Se necesitan mínimo 3 jugadores.');
        return;
    }

    if (config) {
        if (config.categories) room.config.allowedCategories = config.categories;
        if (config.impostors) room.config.impostorCount = config.impostors;
    }

    const availableCats = room.config.allowedCategories; 
    let categoryToUse = 'random';
    if (availableCats.length > 0 && !availableCats.includes('random')) {
        categoryToUse = availableCats[Math.floor(Math.random() * availableCats.length)];
    }

    const { word, category } = getRandomWord(categoryToUse);

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
    
    const currentRoundId = Date.now();

    console.log(`🎮 Start ${code}: ${word} (${category}) | Impostores: ${desiredImpostors}`);

    room.players.forEach(player => {
      const isImpostor = selectedImpostorIds.includes(player.id);
      // Guardamos el rol en el jugador por si se reconecta
      player.role = isImpostor ? 'impostor' : 'jugador';

      const secretPayload = {
        gameStarted: true,
        roundId: currentRoundId,
        role: player.role,
        location: isImpostor ? '???' : word, 
        category: category,
        players: room.players,
        impostorCount: desiredImpostors 
      };
      
      io.to(player.id).emit('game_started', secretPayload);
    });
  });

  socket.on('start_debate', ({ roomCode }) => {
    const code = roomCode?.toUpperCase();
    io.to(code).emit('debate_started');
  });

  // --- 4. DESCONEXIÓN SEGURA ---
  socket.on('disconnect', () => {
    const code = socket.currentRoom;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    const player = room.players.find(p => p.id === socket.id);

    if (player) {
        console.log(`⚠️ ${player.name} perdió conexión. Esperando reconexión...`);
        player.connected = false;
        
        // Notificamos visualmente que alguien se cayó (opcional, si el frontend lo soporta)
        io.to(code).emit('update_players', room.players);

        // INICIAMOS TEMPORIZADOR DE 15 SEGUNDOS
        // Si no vuelve en 15s, lo borramos de verdad.
        disconnectTimers[socket.id] = setTimeout(() => {
            if (!rooms[code]) return; // La sala ya murió

            // Verificar si sigue desconectado (por si acaso)
            const pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1 && !room.players[pIndex].connected) {
                console.log(`🗑️ Eliminando a ${player.name} por inactividad.`);
                
                const wasHost = room.players[pIndex].isHost;
                room.players.splice(pIndex, 1);

                if (room.players.length === 0) {
                    delete rooms[code];
                    console.log(`💀 Sala ${code} eliminada.`);
                } else {
                    if (wasHost) {
                        room.players[0].isHost = true;
                        room.hostId = room.players[0].id;
                    }
                    io.to(code).emit('update_players', room.players);
                }
            }
            delete disconnectTimers[socket.id];
        }, 6000000); // 15 segundos de gracia
    }
  });

  socket.on('disconnect_game', () => {
    // Si el usuario da click en "Salir", borramos inmediatamente sin esperar
    const code = socket.currentRoom;
    if(code && rooms[code]) {
        // Limpiamos lógica manual aquí si fuera necesario, 
        // pero socket.disconnect() disparará el evento de arriba.
        // Para diferenciar "salir voluntario" de "caída", podrías enviar un flag.
    }
    socket.disconnect(); 
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 SERVIDOR LISTO EN PUERTO ${PORT}`);
});