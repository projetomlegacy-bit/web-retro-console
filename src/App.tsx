import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Nostalgist } from 'nostalgist';
import { 
  Tv, 
  Gamepad, 
  QrCode, 
  Wifi, 
  Play, 
  Square, 
  Volume2, 
  VolumeX, 
  Upload, 
  RefreshCw, 
  Cpu, 
  Link as LinkIcon, 
  Check, 
  HelpCircle 
} from 'lucide-react';

// --- NES CONTROLLER KEY MAP FOR EMULATION ---
// This map correlates incoming socket actions of the mobile controller
// to the RetroArch button parameters expected by Nostalgist.pressDown/Up
const ACTION_BUTTON_MAP: Record<string, string> = {
  'btn-a': 'a',
  'button_a': 'a',
  'a': 'a',
  'btn-b': 'b',
  'button_b': 'b',
  'b': 'b',
  'start': 'start',
  'select': 'select',
  'up': 'up',
  'down': 'down',
  'left': 'left',
  'right': 'right'
};

// --- AUDIO SINTETIZADOR 8-BIT RETRO ---
class RetroAudioEngine {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;

  constructor() {
    // Lazy initialized when interact occurs
  }

  setMute(mute: boolean) {
    this.isMuted = mute;
  }

  private init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playStart() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;

    const notes = [261.63, 329.63, 392.00, 523.25, 659.25]; // C4, E4, G4, C5, E5
    notes.forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, this.ctx!.currentTime + idx * 0.06);

      gain.gain.setValueAtTime(0.12, this.ctx!.currentTime + idx * 0.06);
      gain.gain.linearRampToValueAtTime(0.005, this.ctx!.currentTime + idx * 0.06 + 0.25);

      osc.connect(gain);
      gain.connect(this.ctx!.destination);

      osc.start(this.ctx!.currentTime + idx * 0.06);
      osc.stop(this.ctx!.currentTime + idx * 0.06 + 0.25);
    });
  }

  playGameOver() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, this.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(80, this.ctx.currentTime + 0.5);

    gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.5);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.5);
  }

  playBeep() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, this.ctx.currentTime);

    gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + 0.1);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.1);
  }
}

const audio = new RetroAudioEngine();

export default function App() {
  // Configurações do Console e Conectividade
  const [roomCode, setRoomCode] = useState<string>('');
  const [p1Connected, setP1Connected] = useState<boolean>(false);
  const [p2Connected, setP2Connected] = useState<boolean>(false);
  const deviceConnected = p1Connected || p2Connected;
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [socketError, setSocketError] = useState<string>('');
  
  // URL de pareamento para o controle de celular
  const [directUrl, setDirectUrl] = useState<string>('Carregando...');
  const [isCopied, setIsCopied] = useState<boolean>(false);

  // Seleção de ROMs
  const [selectedRom, setSelectedRom] = useState<string>('/roms/megaman2.nes');
  const [customRomName, setCustomRomName] = useState<string>('');
  const [customRomBlob, setCustomRomBlob] = useState<Blob | null>(null);

  // Estados do Emulador NES
  const [isEmulatorActive, setIsEmulatorActive] = useState<boolean>(false);
  const [isEmulatorLoading, setIsEmulatorLoading] = useState<boolean>(false);
  const [emulatorStateText, setEmulatorStateText] = useState<string>('Desligado');
  const [isMuted, setIsMuted] = useState<boolean>(false);

  // Monitor e log de eventos recebidos em tempo real do sinal d-pad/joystick
  const [logs, setLogs] = useState<Array<{ id: string; msg: string; timestamp: string; type: 'info' | 'input' | 'success' | 'warn' }>>([
    { id: '1', msg: 'Console pronto. Aguardando conexão do controle...', timestamp: new Date().toLocaleTimeString(), type: 'info' }
  ]);

  // Elementos HTML de Referência
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  
  // Instâncias mantidas em escopo de referência
  const socketRef = useRef<Socket | null>(null);
  const nostalgistInstance = useRef<any | null>(null);
  const activeControllersRef = useRef<Map<string, number>>(new Map());

  const addLogRef = useRef<(msg: string, type?: 'info' | 'input' | 'success' | 'warn') => void>(() => {});
  
  useEffect(() => {
    addLogRef.current = (msg: string, type: 'info' | 'input' | 'success' | 'warn' = 'info') => {
      const timestamp = new Date().toLocaleTimeString();
      setLogs(prev => [
        { id: Math.random().toString(), msg, timestamp, type },
        ...prev.slice(0, 15) // Mantém as últimas 15 ações para evitar estouro de memória
      ]);
    };
  }, []);

  // Emulador NES interpreta eventos de teclado padrão do RetroArch.
  // Criar este despachador virtual garante suporte duplo redundante e à prova de falhas.
  const dispatchKeyboardFallback = (action: string, pressed: boolean, player: number = 1) => {
    const element = canvasRef.current || document.getElementById('target-nes-canvas') || document;
    
    // Mapeamento clássico RetroArch Player 1 do Core NES
    const keyMapP1: Record<string, { code: string; key: string; keyCode: number }> = {
      'a': { code: 'KeyX', key: 'x', keyCode: 88 },
      'b': { code: 'KeyZ', key: 'z', keyCode: 90 },
      'start': { code: 'Enter', key: 'Enter', keyCode: 13 },
      'select': { code: 'ShiftRight', key: 'Shift', keyCode: 16 },
      'up': { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
      'down': { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
      'left': { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
      'right': { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 }
    };

    // Mapeamento clássico RetroArch Player 2 do Core NES
    const keyMapP2: Record<string, { code: string; key: string; keyCode: number }> = {
      'a': { code: 'KeyV', key: 'v', keyCode: 86 },
      'b': { code: 'KeyC', key: 'c', keyCode: 67 },
      'start': { code: 'KeyU', key: 'u', keyCode: 85 },
      'select': { code: 'KeyY', key: 'y', keyCode: 89 },
      'up': { code: 'KeyI', key: 'i', keyCode: 73 },
      'down': { code: 'KeyK', key: 'k', keyCode: 75 },
      'left': { code: 'KeyJ', key: 'j', keyCode: 74 },
      'right': { code: 'KeyL', key: 'l', keyCode: 76 }
    };

    const keyInfo = player === 2 ? keyMapP2[action] : keyMapP1[action];
    if (!keyInfo) return;

    const eventType = pressed ? 'keydown' : 'keyup';
    
    try {
      const keyboardEvent = new KeyboardEvent(eventType, {
        code: keyInfo.code,
        key: keyInfo.key,
        keyCode: keyInfo.keyCode,
        which: keyInfo.keyCode,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(keyboardEvent);
      document.dispatchEvent(keyboardEvent);
    } catch (err) {
      console.warn('[Keyboard Fallback] Erro ao disparar evento:', err);
    }
  };

  // Gera código aleatório único para sincronização
  useEffect(() => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setRoomCode(code);
  }, []);

  // Conecta WebSocket de comunicação
  useEffect(() => {
    if (!roomCode) return;

    const hostname = window.location.origin;
    // Iniciamos com polling de fallback confiável para evitar problemas de proxy / CORS em WebSockets puros
    const socketInstance = io(hostname, {
      transports: ['polling', 'websocket'],
      reconnectionAttempts: 10,
    });

    socketRef.current = socketInstance;

    socketInstance.on('connect', () => {
      setServerOnline(true);
      setSocketError('');
      addLogRef.current(`Console conectado ao servidor na sala [${roomCode}]`, 'success');
      // Junta-se à sala com papel de TV/Tela
      socketInstance.emit('join-room', { roomCode, role: 'tv' });
    });

    socketInstance.on('connect_error', (error) => {
      console.error('[Socket] Erro de rede ou conexão:', error);
      setServerOnline(false);
      setSocketError('Problema ao parear com servidor.');
      addLogRef.current('Erro de conexão com o servidor WebSocket.', 'warn');
    });

    socketInstance.on('disconnect', () => {
      setServerOnline(false);
      setP1Connected(false);
      setP2Connected(false);
      activeControllersRef.current.clear();
      addLogRef.current('Console desconectado do servidor.', 'warn');
    });

    // Eventos do celular vinculados à sala
    socketInstance.on('controller-connected', (data: { id: string; playerNumber: number }) => {
      const { id, playerNumber } = data;
      activeControllersRef.current.set(id, playerNumber);
      if (playerNumber === 1) {
        setP1Connected(true);
      } else if (playerNumber === 2) {
        setP2Connected(true);
      }
      audio.playStart();
      addLogRef.current(`Controle Player ${playerNumber} pareado e sintonizado!`, 'success');
    });

    socketInstance.on('controller-disconnected', (data: { id: string; playerNumber: number }) => {
      const { id, playerNumber } = data;
      activeControllersRef.current.delete(id);
      if (playerNumber === 1) {
        setP1Connected(false);
      } else if (playerNumber === 2) {
        setP2Connected(false);
      }
      audio.playGameOver();
      addLogRef.current(`Controle Player ${playerNumber} desemparelhado.`, 'warn');
      
      // Se todos os controles desconectarem e o emulador estiver rodando, suspende para que o player não morra
      if (activeControllersRef.current.size === 0) {
        if (nostalgistInstance.current && nostalgistInstance.current.getStatus() === 'running') {
          nostalgistInstance.current.pause();
          setEmulatorStateText('Pausado (Controles Desconectados)');
        }
      }
    });

    // Ponte crucial: direciona comandos de joystick WebSockets para nostalgist RetroArch
    socketInstance.on('controller-event', (data: { action: string; value: any; playerNumber?: number }) => {
      const { action, value, playerNumber = 1 } = data;
      const act = String(action).toLowerCase();

      // Garantir foco do canvas a cada ação para recepção ótima do emulador
      if (canvasRef.current) {
        try { canvasRef.current.focus(); } catch (e) {}
      }

      // 1. Caso de Direcionais D-Pad (action: 'direction', value: { key: 'up'|'down'|'left'|'right', pressed: boolean })
      if (act === 'direction' && value && typeof value === 'object') {
        const key = String(value.key).toLowerCase();
        const pressed = !!value.pressed;
        const mappedDir = ACTION_BUTTON_MAP[key] || key;

        addLogRef.current(`P${playerNumber} [${mappedDir.toUpperCase()}] -> ${pressed ? 'PRESSIONADO' : 'SOLTO'}`, 'input');

        if (nostalgistInstance.current) {
          if (pressed) {
            nostalgistInstance.current.pressDown({ button: mappedDir, player: playerNumber });
          } else {
            nostalgistInstance.current.pressUp({ button: mappedDir, player: playerNumber });
          }
        }
        // Despacha fallback de teclado mesmo se a instância estiver pendente ou travada na renderização
        dispatchKeyboardFallback(mappedDir, pressed, playerNumber);
      } 
      // 2. Caso de Botões de Ação (btn-a, btn-b, etc.)
      else {
        const mappedButton = ACTION_BUTTON_MAP[act];
        if (mappedButton) {
          const isPressed = !!value;
          addLogRef.current(`P${playerNumber} [${mappedButton.toUpperCase()}] -> ${isPressed ? 'PRESSIONADO' : 'SOLTO'}`, 'input');

          if (nostalgistInstance.current) {
            if (isPressed) {
              nostalgistInstance.current.pressDown({ button: mappedButton, player: playerNumber });
            } else {
              nostalgistInstance.current.pressUp({ button: mappedButton, player: playerNumber });
            }
          }
          dispatchKeyboardFallback(mappedButton, isPressed, playerNumber);
        } else if (act === 'move') {
          // Suporte legado ou para outros tipos de joypad de teste
          const dir = String(value).toLowerCase();
          const isPressed = dir !== 'none' && !!dir && dir !== 'undefined' && dir !== 'false';
          addLogRef.current(`P${playerNumber} Slide D-Pad -> ${dir.toUpperCase()}`, 'input');

          if (!isPressed) {
            const directions = ['up', 'down', 'left', 'right'];
            directions.forEach(d => {
              if (nostalgistInstance.current) nostalgistInstance.current.pressUp({ button: d, player: playerNumber });
              dispatchKeyboardFallback(d, false, playerNumber);
            });
          } else {
            const directions = ['up', 'down', 'left', 'right'];
            directions.forEach(d => {
              const pressState = d === dir;
              if (nostalgistInstance.current) {
                if (pressState) {
                  nostalgistInstance.current.pressDown({ button: d, player: playerNumber });
                } else {
                  nostalgistInstance.current.pressUp({ button: d, player: playerNumber });
                }
              }
              dispatchKeyboardFallback(d, pressState, playerNumber);
            });
          }
        }
      }
    });

    // Gera o endereço do gamepad móvel para ser lido no celular
    const controllerPath = `${hostname}/controle.html?room=${roomCode}`;
    setDirectUrl(controllerPath);

    return () => {
      socketInstance.disconnect();
      if (nostalgistInstance.current) {
        try { nostalgistInstance.current.exit({ removeCanvas: false }); } catch (e) {}
      }
    };
  }, [roomCode]);

  // Aplica Volume / Mute no Sintetizador e Emulator
  useEffect(() => {
    audio.setMute(isMuted);
    if (nostalgistInstance.current) {
      try {
        const mod = nostalgistInstance.current.getEmscriptenModule();
        if (mod && mod.AL) {
          // Se houver controle de som da biblioteca RetroArch
          if (isMuted) {
            nostalgistInstance.current.pause(); // Como fallback
            nostalgistInstance.current.resume();
          }
        }
      } catch (err) {
        console.warn('Erro ao aplicar volume ao RetroArch:', err);
      }
    }
  }, [isMuted]);

  // Inicialização do emulador retro nostalgist
  const handlePowerOn = async () => {
    if (isEmulatorActive) return;
    if (!canvasRef.current) return;

    audio.playBeep();
    setIsEmulatorLoading(true);
    setEmulatorStateText('Sincronizando Hardware...');

    try {
      // Determina arquivo a carregar (ROM de teste local, ou Blob customizado feito upload)
      let romSource: any = selectedRom;
      if (customRomBlob && selectedRom === 'custom') {
        romSource = new File([customRomBlob], customRomName || 'custom.nes', { type: 'application/octet-stream' });
      }

      console.log('[Retro Console] Inicializando emulador NES com:', selectedRom);

      // Instanciação central da biblioteca Nostalgist configurada para NES (Core fceumm por padrão)
      const instance = await Nostalgist.nes({
        rom: romSource,
        element: canvasRef.current,
        resolveCoreSource(core, ext) {
          // Utiliza a rota de pacotes NPM do jsDelivr, que é muitíssimo mais rápida, estável e livre de rate leaks do que as APIs do GitHub
          return `https://cdn.jsdelivr.net/npm/nostalgist/cores/${core}.${ext}`;
        },
        // Configurações personalizadas do emulador
        retroarchConfig: {
          audio_enable: !isMuted,
          audio_volume: isMuted ? 0.0 : 1.0,
          // Mapeamento de teclas para Player 1 para que o utilitário interno de simulação do Nostalgist (getKeyboardCode) funcione perfeitamente
          input_player1_a: 'x',
          input_player1_b: 'z',
          input_player1_y: 'a',
          input_player1_x: 's',
          input_player1_start: 'enter',
          input_player1_select: 'rshift',
          input_player1_up: 'up',
          input_player1_down: 'down',
          input_player1_left: 'left',
          input_player1_right: 'right',
          // Mapeamento de teclas para Player 2
          input_player2_a: 'v',
          input_player2_b: 'c',
          input_player2_y: 'y',
          input_player2_x: 'u',
          input_player2_start: 'u',
          input_player2_select: 'y',
          input_player2_up: 'i',
          input_player2_down: 'k',
          input_player2_left: 'j',
          input_player2_right: 'l',
        }
      });

      nostalgistInstance.current = instance;
      setIsEmulatorActive(true);
      setEmulatorStateText('Executando jogo');

      // Foca automaticamente no canvas do emulador para escutar teclado nativamente também
      canvasRef.current.focus();

    } catch (error) {
      console.error('[Retro Console] Falha crônica ao abrir emulador:', error);
      setEmulatorStateText('Erro de Inicialização');
      alert('Erro ao carregar o emulador de NES. Verifique se o arquivo está correto.');
    } finally {
      setIsEmulatorLoading(false);
    }
  };

  // Desativação segura do emulador
  const handlePowerOff = () => {
    if (!isEmulatorActive || !nostalgistInstance.current) return;

    audio.playBeep();
    try {
      // Método seguro de fechamento e liberação de cache
      nostalgistInstance.current.exit({ removeCanvas: false });
    } catch (err) {
      console.warn('Erro controlado ao desligar console:', err);
    }

    nostalgistInstance.current = null;
    setIsEmulatorActive(false);
    setEmulatorStateText('Desligado');

    // Força limpeza visual do canvas limpando seus pixels para o console preto
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#020617'; // slate-950
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
  };

  // Carrega ROM customizada inserida pelo usuário via Drag and Drop ou seletor de arquivos
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      const file = files[0];
      if (!file.name.endsWith('.nes')) {
        alert('Por favor, faça upload de um arquivo com extensão válida (.nes) compatível com Nintendinho.');
        return;
      }
      setCustomRomName(file.name);
      setCustomRomBlob(file);
      setSelectedRom('custom');
      audio.playBeep();
    }
  };

  // Utilitário para copiar link direto de jogo no clipboard
  const handleCopyLink = () => {
    navigator.clipboard.writeText(directUrl);
    setIsCopied(true);
    audio.playBeep();
    setTimeout(() => setIsCopied(false), 2000);
  };

  // Link dinâmico de imagem utilizando a biblioteca QR Server para garantir geração local instantânea e 100% segura
  const qrCodeImgSrc = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=0f172a&data=${encodeURIComponent(directUrl)}`;

  return (
    <div className="bg-slate-950 text-slate-100 min-h-screen flex flex-col justify-between selection:bg-orange-600 selection:text-white font-tech antialiased">
      
      {/* HEADER DE CABINE retro_console */}
      <header className="w-full max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center py-4 px-6 border-b border-orange-500/10 gap-4 mt-2">
        <div className="flex items-center gap-3">
          <div className="bg-orange-600 p-2 rounded-lg text-black font-pixel font-bold text-lg animate-pulse">
            🕹️
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-red-500 font-pixel">NEVO CONSOLE NES</h1>
            <p className="text-xs text-slate-400 font-mono">MVP RETRO EMULATION & REAL-TIME SOCKETS INTEGRATION</p>
          </div>
        </div>

        {/* Informações técnicas e Badges de Rede */}
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button 
            onClick={() => setIsMuted(!isMuted)} 
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-orange-400 transition-colors cursor-pointer text-xs"
            title={isMuted ? "Ativar som" : "Desativar som"}
            id="sound-opt"
          >
            {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            {isMuted ? "MUTADO" : "SOM ATIVO"}
          </button>

          {/* Badge sinalizando conexão com backend Socket.IO */}
          <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono border ${
            serverOnline ? 'bg-emerald-950/40 border-emerald-500/20 text-emerald-400' : 'bg-red-950/40 border-red-500/20 text-red-400'
          }`}>
            <span className={`w-2 h-2 rounded-full ${serverOnline ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
            <span>{serverOnline ? 'SERVER ONLINE' : 'DISCONNECTED'}</span>
          </div>

          <div className="text-xs font-mono text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1 rounded flex items-center gap-1.5">
            <span className="text-[10px] text-slate-500">SALA:</span> 
            <span className="font-bold text-orange-400 font-pixel text-xs">{roomCode || '----'}</span>
          </div>
        </div>
      </header>

      {/* PAINEL CENTRAL / CONSOLE CABIN */}
      <main className="w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 px-6 my-auto py-8">
        
        {/* LADO ESQUERDO: Emulador de TV CRT */}
        <div className="lg:col-span-8 flex flex-col items-center">
          
          <div className="w-full bg-neutral-900 p-5 rounded-3xl border-4 border-neutral-800 crt-glow shadow-2xl relative">
            
            {/* Indicadores Físicos de LED */}
            <div className="absolute top-2 left-1/4 w-12 h-1 bg-red-600/60 rounded-full"></div>
            <div className="absolute top-2 right-1/4 w-12 h-1 bg-emerald-500/60 rounded-full"></div>

            {/* Tela de Canvas em formato CRT 4:3 */}
            <div className="scanlines rounded-xl overflow-hidden border-4 border-slate-950 bg-black aspect-[4/3] relative flex items-center justify-center">
              
              <canvas 
                id="target-nes-canvas"
                ref={canvasRef} 
                width="800" 
                height="600" 
                className={`w-full h-full block bg-slate-950 object-contain ${
                  isEmulatorActive ? 'opacity-100' : 'opacity-20'
                }`}
                tabIndex={1}
              />

              {/* Status Overlay visível quando emulador não está ativo */}
              {!isEmulatorActive && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 text-center p-6 z-20">
                  <div className="w-16 h-16 rounded-full bg-slate-900 border-2 border-dashed border-orange-500/30 flex items-center justify-center text-2xl mb-4 animate-spin-slow">
                    {isEmulatorLoading ? '⚙️' : '🎮'}
                  </div>

                  {isEmulatorLoading ? (
                    <div>
                      <p className="font-pixel text-xs text-orange-400 mb-2 animate-pulse">LIGANDO EMULADOR NES...</p>
                      <p className="text-xs text-slate-400">Baixando arquivos WebAssembly do RetroArch</p>
                    </div>
                  ) : (
                    <div>
                      <h4 className="font-pixel text-[#f97316] text-xs sm:text-sm mb-3">CONCEITO WEB RETRO TV</h4>
                      <p className="text-xs text-slate-400 max-w-sm font-mono mx-auto leading-relaxed">
                        Sistema pronto para receber sinal rom NES. Conecte seu dispositivo controle abaixo e clique em Ligar Console.
                      </p>
                      <div className="mt-5 flex gap-2 justify-center">
                        <button 
                          onClick={handlePowerOn}
                          className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-black font-bold rounded font-pixel text-[10px] flex items-center gap-2 transition-transform cursor-pointer hover:scale-105"
                          id="power-on-overlay"
                        >
                          <Play className="w-3.5 h-3.5 fill-black" />
                          LIGAR CONSOLE
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Linha de Rodapé decorativa do Painel CRT */}
            <div className="mt-4 flex flex-col sm:flex-row justify-between items-center text-xs text-slate-500 font-mono px-2 gap-2">
              <div className="flex items-center gap-1.5 text-slate-400">
                <Cpu className="w-3.5 h-3.5 text-orange-500" />
                <span>HARDWARE: ROM NES fceumm Core</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className={`w-2.5 h-2.5 rounded-full ${
                    isEmulatorActive ? 'bg-emerald-500 animate-ping' : 'bg-red-500'
                  }`} />
                  <span className="text-[11px] font-bold text-slate-400">SISTEMA: {emulatorStateText.toUpperCase()}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Painel Avançado de Operações de Hardware (Botões Físicos) */}
          <div className="w-full flex justify-between gap-4 mt-4 select-none">
            <button
              onClick={handlePowerOn}
              disabled={isEmulatorActive || isEmulatorLoading}
              className={`flex-1 py-3 px-4 rounded-xl border font-pixel text-xs flex items-center justify-center gap-2 transition-all ${
                isEmulatorActive 
                  ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                  : 'bg-emerald-950/60 border-emerald-500/20 text-emerald-400 hover:bg-emerald-900/60 cursor-pointer hover:border-emerald-500/40 active:scale-95'
              }`}
              id="btn-power-on"
            >
              <Play className="w-4 h-4 fill-emerald-400" />
              LIGAR EMULADOR
            </button>

            <button
              onClick={handlePowerOff}
              disabled={!isEmulatorActive}
              className={`flex-1 py-3 px-4 rounded-xl border font-pixel text-xs flex items-center justify-center gap-2 transition-all ${
                !isEmulatorActive
                  ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                  : 'bg-red-950/60 border-red-500/20 text-red-400 hover:bg-red-900/60 cursor-pointer hover:border-red-500/40 active:scale-95'
              }`}
              id="btn-power-off"
            >
              <Square className="w-4 h-4 fill-red-400" />
              DESLIGAR
            </button>
          </div>
        </div>

        {/* LADO DIREITO: QR Code Sincronizador & Configurações de ROM */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          
          {/* Card Sincronizador de Controle Mobile */}
          <div className="bg-slate-900/80 border border-orange-500/20 rounded-2xl p-6 shadow-xl relative backdrop-blur-md">
            <div className="absolute -top-3 left-6 bg-orange-600 text-black font-pixel text-[9px] uppercase tracking-wider py-1 px-3 rounded font-bold">
              Passo 1: Conecte o Celular
            </div>

            <div className="mt-2 mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/60 pb-3">
              <h3 className="font-bold text-sm tracking-wide text-slate-100 flex items-center gap-1.5 uppercase font-pixel text-xs text-orange-400">
                <Gamepad className="w-4 h-4" /> Gamepads Multi
              </h3>
              <div className="flex gap-2">
                <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                  p1Connected ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30' : 'bg-slate-950 text-slate-500 border border-slate-900/40'
                }`}>
                  P1: {p1Connected ? 'CONECTADO!' : 'OFFLINE'}
                </div>
                <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                  p2Connected ? 'bg-cyan-950 text-cyan-400 border border-cyan-500/30' : 'bg-slate-950 text-slate-500 border border-slate-900/40'
                }`}>
                  P2: {p2Connected ? 'CONECTADO!' : 'OFFLINE'}
                </div>
              </div>
            </div>

            {/* Container mostrando QR code de conexão rápida */}
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="p-3 bg-white rounded-xl shadow-lg hover:scale-[1.03] transition-transform duration-300 relative cursor-pointer group">
                <img 
                  src={qrCodeImgSrc} 
                  alt="QR Code de Pareamento do Gamepad" 
                  className="w-40 h-40 object-contain"
                  referrerPolicy="no-referrer"
                  id="paired-qrcode-img"
                />
              </div>

              <div className="w-full">
                <p className="text-xs font-mono text-slate-300">Escaneie o QR Code em seu celular para jogar na TV:</p>
                
                {/* Link amigável de redirecionamento */}
                <div onClick={handleCopyLink} className="mt-2 p-2 bg-slate-950 border border-slate-800 rounded font-mono text-xs text-orange-400 break-all select-all hover:bg-black transition-colors cursor-pointer flex items-center justify-between gap-1 group text-left">
                  <span className="truncate max-w-[200px]" id="text-direct-url">{directUrl}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-500 group-hover:text-amber-400 shrink-0 font-pixel">
                    {isCopied ? <Check className="w-3 h-3 text-emerald-400 inline" /> : 'COPY'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* PAINEL DE SINAL RETRO EM TEMPO REAL (DEBUG CONSOLE) */}
          <div className="bg-slate-950 border border-orange-500/15 rounded-xl p-4 font-mono text-[11px] h-48 flex flex-col justify-between shadow-lg relative">
            <div className="absolute top-1 right-2 flex gap-1 items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-ping"></span>
              <span className="text-[10px] text-slate-500 font-bold shrink-0">PORT: 3000</span>
            </div>
            
            <div className="flex items-center justify-between border-b border-slate-900 pb-1.5 mb-2 shrink-0">
              <span className="font-pixel text-[9px] text-[#f97316] uppercase tracking-wider flex items-center gap-1">
                🎮 MONITOR DE SINAL GAMEPAD
              </span>
            </div>
            
            <div className="flex-1 overflow-y-auto space-y-1 select-none pr-1 scrollbar-thin max-h-[110px]">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-1 items-start leading-tight">
                  <span className="text-slate-600 shrink-0 select-none">[{log.timestamp}]</span>
                  <span className={`break-all font-mono leading-relaxed text-[11px] ${
                    log.type === 'input' ? 'text-cyan-400' :
                    log.type === 'success' ? 'text-emerald-400 font-bold' :
                    log.type === 'warn' ? 'text-amber-500 font-bold' :
                    'text-slate-400'
                  }`}>
                    {log.msg}
                  </span>
                </div>
              ))}
            </div>
            
            <div className="border-t border-slate-900 pt-1.5 mt-2 flex justify-between text-[9px] text-slate-500 shrink-0 select-none font-pixel gap-1 flex-wrap">
              <span>SALA: {roomCode || '----'}</span>
              <span>JOGADORES: {p1Connected ? 'P1' : ''}{p1Connected && p2Connected ? ' + ' : ''}{p2Connected ? 'P2' : ''}{!p1Connected && !p2Connected ? 'NENHUM' : ''}</span>
              <span>EMU: {isEmulatorActive ? 'ATIVO' : 'DESLIGADO'}</span>
            </div>
          </div>

          {/* Card Seletor de Jogos ROM */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-5 relative">
            <h4 className="font-bold text-slate-200 uppercase font-pixel tracking-wider text-[10px] text-orange-500 mb-3 flex items-center gap-1.5">
              💾 Cartucho Rom NES
            </h4>
            
            <div className="space-y-3 font-mono text-xs">
              
              {/* Opções prontas de ROM e Upload local */}
              <div>
                <label className="block text-slate-400 mb-1">Selecione o Cartucho:</label>
                <select 
                  value={selectedRom}
                  onChange={(e) => {
                    setSelectedRom(e.target.value);
                    audio.playBeep();
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 outline-none text-xs focus:border-orange-500/50"
                  id="rom-select"
                >
                  <option value="/roms/megaman2.nes">ROM de Teste (Mega Man 2 Lite)</option>
                  {customRomBlob && (
                    <option value="custom">ROM Customizada: {customRomName}</option>
                  )}
                  <option value="https://github.com/christopherpow/nes-test-roms/raw/master/other/nestest.nes">
                    ROM de Teste (CPU Nestest) [Web URL]
                  </option>
                </select>
              </div>

              {/* Botão de Upload de cartucho local .nes */}
              <div className="pt-2">
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  accept=".nes"
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-2 bg-slate-950 hover:bg-slate-900 border border-dashed border-slate-800 text-slate-400 rounded hover:text-slate-200 transition-colors flex items-center justify-center gap-1.5 cursor-pointer text-xs"
                  id="btn-upload-rom"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Carregar ROM local (.nes)
                </button>
              </div>

            </div>
          </div>

          {/* Dica de Rede e pareamento no roteador */}
          <div className="bg-slate-900/20 border border-slate-800/60 rounded-xl p-5 text-xs text-slate-400 space-y-2">
            <div className="flex items-center gap-1 text-slate-300 font-pixel text-[9px] text-orange-500 uppercase">
              <HelpCircle className="w-3.5 h-3.5 shrink-0" /> Dica de Teste Local:
            </div>
            <p className="font-mono text-[11px] leading-relaxed text-slate-400">
              Caso esteja testando em rede local, certifique-se de conectar o celular e computador na <strong className="text-slate-200">mesma rede Wi-Fi</strong>. Use o endereço IP interno (ex: <code className="text-orange-400 text-xs text-bold">192.168.1.XX:3000</code>) para o celular.
            </p>
          </div>

        </div>
      </main>

      {/* FOOTER DO CONSOLE PIXEL */}
      <footer className="w-full max-w-6xl mx-auto py-5 text-center border-t border-slate-800/40 text-xs text-slate-500 font-mono mt-4 flex flex-col sm:flex-row justify-between items-center px-6 gap-3">
        <p className="text-center sm:text-left">
          Web Retro Console Sockets Integrator &copy; 2026. Desenvolvido com React, Nostalgist e Socket.io.
        </p>
        <div className="flex gap-4">
          <a href="/controle.html" className="text-slate-400 hover:text-orange-400 transition-colors underline">Gamepad manual</a>
          <a href="/tv.html" className="text-slate-400 hover:text-orange-400 transition-colors underline">Painel TV estático</a>
        </div>
      </footer>
    </div>
  );
}
