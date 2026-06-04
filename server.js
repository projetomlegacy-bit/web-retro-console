/**
 * @file server.js
 * @description Servidor Node.js (com Express e Socket.io) para o Console Retro Web.
 * Gerencia a comunicação WebSocket de baixa latência e serve a interface da TV e do controle.
 * 
 * Este arquivo utiliza a especificação ES Modules (import/export) devido à configuração "type": "module" do package.json.
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolvendo caminhos para compatibilidade com ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Inicializa o Socket.io acoplado ao servidor HTTP
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Configura o middleware para servir os arquivos estáticos da pasta "public"
app.use(express.static(path.join(__dirname, 'public')));

// Rota principal: redireciona ou serve a tela da TV por padrão
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});

// Endpoint opcional para expor variáveis de ambiente do servidor, se necessário
app.get('/api/config', (req, res) => {
  res.json({
    appUrl: process.env.APP_URL || ''
  });
});

/**
 * Gerenciamento de Salas em Tempo Real
 * Estrutura de armazenamento na memória do servidor para salas ativas:
 * Map { [roomCode] => { tv: socketId, controllers: Set(socketId) } }
 */
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket] Conexão estabelecida: ${socket.id}`);

  // Evento disparado quando um dispositivo (TV ou Controle) deseja entrar em uma sala
  socket.on('join-room', ({ roomCode, role }) => {
    if (!roomCode) return;
    
    const formattedCode = roomCode.toUpperCase().trim();
    socket.join(formattedCode);
    socket.roomCode = formattedCode;
    socket.role = role;

    console.log(`[Socket] Dispositivo ${socket.id} entrou na sala ${formattedCode} como [${role}]`);

    if (role === 'tv') {
      // Registra ou atualiza o gerenciamento da sala para a TV principal
      if (!rooms.has(formattedCode)) {
        rooms.set(formattedCode, { tv: socket.id, controllers: new Set() });
      } else {
        rooms.get(formattedCode).tv = socket.id;
      }
      socket.emit('status', { success: true, message: `Sala ${formattedCode} registrada com sucesso.` });
      
    } else if (role === 'controller') {
      const room = rooms.get(formattedCode);
      if (room && room.tv) {
        // Vincula o controle à sala ativa
        room.controllers.add(socket.id);
        
        // Notifica o controle de sucesso
        socket.emit('status', { success: true, message: `Conectado ao Console da sala ${formattedCode}.` });
        
        // Notifica a TV que um novo controle se conectou
        io.to(room.tv).emit('controller-connected', { id: socket.id });
      } else {
        // Devolve erro indicando que a sala de console não existe ou está inativa
        socket.emit('status', { 
          success: false, 
          message: `Código inválido ou sala ${formattedCode} não encontrada. Ative a tela da TV primeiro!` 
        });
      }
    }
  });

  // Repassa os sinais de entrada (joystick, botões, giroscópio) recebidos do controle para a TV da sala correspondente
  socket.on('controller-input', (data) => {
    if (socket.roomCode && socket.role === 'controller') {
      const room = rooms.get(socket.roomCode);
      if (room && room.tv) {
        // Envia de forma direcionada apenas para o socket da TV correspondente
        io.to(room.tv).emit('controller-event', {
          id: socket.id,
          action: data.action, // 'move', 'btn-a', 'btn-b', 'start', 'select'
          value: data.value    // dados adicionais (ex: direção, pressionado true/false, etc.)
        });
      }
    }
  });

  // Limpeza de recursos ao desconectar um usuário
  socket.on('disconnect', () => {
    console.log(`[Socket] Desconectado: ${socket.id}`);
    const roomCode = socket.roomCode;
    if (roomCode) {
      const room = rooms.get(roomCode);
      if (room) {
        if (socket.role === 'tv') {
          // Se a TV principal cair, avisa todos os controles e encerra a sala
          io.to(roomCode).emit('tv-disconnected');
          rooms.delete(roomCode);
          console.log(`[Sala] Sala ${roomCode} encerrada porque a TV principal desconectou.`);
        } else if (socket.role === 'controller') {
          room.controllers.delete(socket.id);
          // Avisa a TV que o controle saiu
          io.to(room.tv).emit('controller-disconnected', { id: socket.id });
          console.log(`[Canal] Controle ${socket.id} saiu da sala ${roomCode}. Tempos restantes: ${room.controllers.size}`);
        }
      }
    }
  });
});

// Inicialização do servidor na porta 3000 e host 0.0.0.0
server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🎮  SERVIDO RETRO CONSOLE WEB INICIADO!`);
  console.log(`💻  Servidor rodando em http://localhost:${PORT}`);
  console.log(`===============================================`);
});
