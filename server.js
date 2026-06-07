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
import fs from 'fs';

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

// Garante que a rom de teste exista em public/roms/megaman2.nes
async function ensureTestRom() {
  const romsDir = path.join(__dirname, 'public', 'roms');
  const romPath = path.join(romsDir, 'megaman2.nes');
  
  if (!fs.existsSync(romsDir)) {
    fs.mkdirSync(romsDir, { recursive: true });
  }
  
  if (!fs.existsSync(romPath) || fs.statSync(romPath).size < 1000) {
    console.log('[Rom Setup] Baixando rom de NES de teste para o console...');
    try {
      const response = await fetch('https://raw.githubusercontent.com/christopherpow/nes-test-roms/master/other/nestest.nes');
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        fs.writeFileSync(romPath, Buffer.from(arrayBuffer));
        console.log('[Rom Setup] Rom de teste salva com sucesso em /public/roms/megaman2.nes!');
      } else {
        console.warn('[Rom Setup] Erro de status ao baixar rom externa, salvando arquivo local temporário de simulação.');
        fs.writeFileSync(romPath, Buffer.from("DUMMY NES ROM HEADER"));
      }
    } catch (err) {
      console.error('[Rom Setup] Erro de conexão ao baixar rom:', err);
      if (!fs.existsSync(romPath)) {
        fs.writeFileSync(romPath, Buffer.from("DUMMY NES ROM HEADER"));
      }
    }
  }
}
ensureTestRom();

// Configura o middleware para servir os arquivos estáticos da pasta "public"
app.use(express.static(path.join(__dirname, 'public')));

// No ambiente de desenvolvimento, integramos o Vite como middleware para podermos rodar o React na rota "/"
const isProd = process.env.NODE_ENV === 'production';
if (!isProd) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  // Em produção, servimos o build gerado em dist/
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

// Endpoint opcional para expor variáveis de ambiente do servidor, se necessário
app.get('/api/config', (req, res) => {
  res.json({
    appUrl: process.env.APP_URL || ''
  });
});

/**
 * Gerenciamento de Salas em Tempo Real
 * Estrutura de armazenamento na memória do servidor para salas ativas:
 * Map { [roomCode] => { tv: socketId, controllers: Map(socketId => playerNumber) } }
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
        rooms.set(formattedCode, { tv: socket.id, controllers: new Map() });
      } else {
        rooms.get(formattedCode).tv = socket.id;
      }
      socket.emit('status', { success: true, message: `Sala ${formattedCode} registrada com sucesso.` });
      
    } else if (role === 'controller') {
      const room = rooms.get(formattedCode);
      if (room && room.tv) {
        // Encontrar o primeiro ID de player disponível (1 ou 2)
        let playerNumber = 1;
        const assignedPlayers = Array.from(room.controllers.values());
        if (assignedPlayers.includes(1)) {
          playerNumber = 2; // Se o player 1 já existe, atribui player 2. Se ambos existem, atribui 2 (ou fallback para 1/2)
        }

        // Vincula o controle à sala ativa com seu playerNumber
        room.controllers.set(socket.id, playerNumber);
        
        // Notifica o controle de sucesso e diz qual player ele é
        socket.emit('status', { 
          success: true, 
          message: `Conectado ao Console da sala ${formattedCode}.`,
          playerNumber: playerNumber
        });
        
        // Notifica a TV que um novo controle se conectou
        io.to(room.tv).emit('controller-connected', { id: socket.id, playerNumber });
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
        const playerNumber = room.controllers.get(socket.id) || 1;
        // Envia de forma direcionada apenas para o socket da TV correspondente
        io.to(room.tv).emit('controller-event', {
          id: socket.id,
          playerNumber: playerNumber,
          action: data.action, // 'move', 'btn-a', 'btn-b', 'start', 'select'
          value: data.value    // dados adicionais (ex: direção, pressionado true/false, etc.)
        });
      }
    }
  });

  // Repassa sinal de mudança de layout do Console TV para todos os controles sintonizados na sala
  socket.on('change-layout', (data) => {
    if (socket.roomCode && socket.role === 'tv') {
      socket.to(socket.roomCode).emit('change-layout', data);
      console.log(`[Layout] TV alterou o layout da sala ${socket.roomCode} para: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    }
  });

  socket.on('layout-change', (data) => {
    if (socket.roomCode && socket.role === 'tv') {
      socket.to(socket.roomCode).emit('layout-change', data);
      console.log(`[Layout] TV alterou o layout da sala ${socket.roomCode} para: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
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
          const playerNumber = room.controllers.get(socket.id) || 1;
          room.controllers.delete(socket.id);
          // Avisa a TV que o controle saiu
          io.to(room.tv).emit('controller-disconnected', { id: socket.id, playerNumber });
          console.log(`[Canal] Controle ${socket.id} (P${playerNumber}) saiu da sala ${roomCode}. Tempos restantes: ${room.controllers.size}`);
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
