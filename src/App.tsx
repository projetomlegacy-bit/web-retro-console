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
  HelpCircle,
  Trash2,
  AlertTriangle,
  FolderOpen,
  FolderPlus,
  FolderMinus,
  Unlock
} from 'lucide-react';

// --- NES & MEGADRIVE CONTROLLER KEY MAP FOR EMULATION ---
// This map correlates incoming socket actions of the mobile controller
// to the RetroArch button parameters expected by Nostalgist.pressDown/Up
const ACTION_BUTTON_MAP: Record<string, string> = {
  'btn-a': 'a',
  'button_a': 'a',
  'a': 'a',
  'btn-b': 'b',
  'button_b': 'b',
  'b': 'b',
  'btn-c': 'c',
  'button_c': 'c',
  'c': 'c',
  'btn-x': 'x',
  'button_x': 'x',
  'x': 'x',
  'btn-y': 'y',
  'button_y': 'y',
  'y': 'y',
  'btn-z': 'z',
  'button_z': 'z',
  'z': 'z',
  'btn-l': 'l',
  'button_l': 'l',
  'l': 'l',
  'btn-r': 'r',
  'button_r': 'r',
  'r': 'r',
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

// --- MULTI-CONSOLE UTILITIES (NES / MEGADRIVE AUTO DETECT) ---
const getConsoleTypeAndCore = (romPathOrName: string) => {
  const name = String(romPathOrName).toLowerCase();
  if (name.endsWith('.md') || name.endsWith('.bin') || name.includes('megadrive') || name.includes('genesis')) {
    return { console: 'megadrive', core: 'genesis_plus_gx', layout: 'megadrive_3' };
  }
  if (name.endsWith('.sms') || name.includes('mastersystem') || name.includes('master system')) {
    return { console: 'sms', core: 'gearsystem', layout: 'master_system' };
  }
  if (name.endsWith('.gba') || name.includes('gameboyadvance') || name.includes('game boy advance') || name.includes('gba')) {
    return { console: 'gba', core: 'mgba', layout: 'gba' };
  }
  if (name.endsWith('.gbc') || name.endsWith('.gb') || name.includes('gameboycolor') || name.includes('game boy color') || name.includes('gbc') || name.includes('gameboy') || name.includes('gb')) {
    return { console: 'gbc', core: 'gambatte', layout: 'nes' };
  }
  if (name.endsWith('.n64') || name.endsWith('.z64') || name.includes('nintendo64') || name.includes('n64')) {
    return { console: 'n64', core: 'mupen64plus_next', layout: 'nes' };
  }
  return { console: 'nes', core: 'fceumm', layout: 'nes' };
};

// --- INDEXEDDB PERSISTENCE LAYER ---
interface StoredRom {
  id: string; // unique identifier (file.name or specific id)
  nome: string; // original displayed file name
  tipo: string; // 'nes' | 'megadrive' | 'sms' | 'gba' | 'gbc' | 'n64'
  data: Blob; // the binary ROM file
}

const openMLegacyDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB não suportado'));
      return;
    }
    const request = window.indexedDB.open('MLegacyDB', 1);

    request.onerror = () => {
      console.error('Erro ao abrir MLegacyDB:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event: any) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('roms')) {
        db.createObjectStore('roms', { keyPath: 'id' });
      }
    };
  });
};

const saveRomToIndexedDB = async (rom: StoredRom): Promise<void> => {
  const db = await openMLegacyDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('roms', 'readwrite');
    const store = transaction.objectStore('roms');
    const request = store.put(rom);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

const getAllRomsFromIndexedDB = async (): Promise<StoredRom[]> => {
  const db = await openMLegacyDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('roms', 'readonly');
    const store = transaction.objectStore('roms');
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
};

const deleteRomFromIndexedDB = async (id: string): Promise<void> => {
  const db = await openMLegacyDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('roms', 'readwrite');
    const store = transaction.objectStore('roms');
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

// --- MLEGACYDIRECTORYDB PERSISTENCE LAYER ---
const openMLegacyDirectoryDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB não suportado'));
      return;
    }
    const request = window.indexedDB.open('MLegacyDirectoryDB', 1);

    request.onerror = () => {
      console.error('Erro ao abrir MLegacyDirectoryDB:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event: any) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('directory')) {
        db.createObjectStore('directory', { keyPath: 'id' });
      }
    };
  });
};

const saveDirectoryHandle = async (handle: FileSystemDirectoryHandle): Promise<void> => {
  const db = await openMLegacyDirectoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('directory', 'readwrite');
    const store = transaction.objectStore('directory');
    const request = store.put({ id: 'main_directory', handle });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

const getDirectoryHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
  const db = await openMLegacyDirectoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('directory', 'readonly');
    const store = transaction.objectStore('directory');
    const request = store.get('main_directory');

    request.onsuccess = () => {
      resolve(request.result ? request.result.handle : null);
    };
    request.onerror = () => reject(request.error);
  });
};

const deleteDirectoryHandle = async (): Promise<void> => {
  const db = await openMLegacyDirectoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('directory', 'readwrite');
    const store = transaction.objectStore('directory');
    const request = store.delete('main_directory');

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export default function App() {
  // Configurações do Console e Conectividade
  const [roomCode, setRoomCode] = useState<string>('');
  const [player1Conectado, setPlayer1Conectado] = useState<boolean>(false);
  const [player2Conectado, setPlayer2Conectado] = useState<boolean>(false);
  const p1Connected = player1Conectado;
  const p2Connected = player2Conectado;
  const deviceConnected = player1Conectado || player2Conectado;
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [socketError, setSocketError] = useState<string>('');
  
  // URL de pareamento para o controle de celular
  const [directUrl, setDirectUrl] = useState<string>('Carregando...');
  const [isCopied, setIsCopied] = useState<boolean>(false);

  // Seleção de ROMs e Estante de Locadora Virtual
  interface Cartucho {
    id: string;
    title: string;
    console: 'nes' | 'megadrive' | 'sms' | 'gba' | 'gbc' | 'n64';
    url: string;
    coverUrl: string;
    customBlob?: Blob;
    customName?: string;
  }

  const [games, setGames] = useState<Cartucho[]>([
    {
      id: '/roms/megaman2.nes',
      title: 'Mega Man 2 Lite',
      console: 'nes',
      url: '/roms/megaman2.nes',
      coverUrl: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&q=80&w=240'
    },
    {
      id: 'https://github.com/Krikzz/EDMD/raw/master/roms/test.bin',
      title: 'Sega Hardware Test',
      console: 'megadrive',
      url: 'https://github.com/Krikzz/EDMD/raw/master/roms/test.bin',
      coverUrl: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&q=80&w=240'
    },
    {
      id: 'https://github.com/christopherpow/nes-test-roms/raw/master/other/nestest.nes',
      title: 'NES CPU Nestest',
      console: 'nes',
      url: 'https://github.com/christopherpow/nes-test-roms/raw/master/other/nestest.nes',
      coverUrl: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?auto=format&fit=crop&q=80&w=240'
    }
  ]);

  const [selectedRom, setSelectedRom] = useState<string>('/roms/megaman2.nes');

  // Directory Access (File System Access API & IndexedDB Persistent Handle)
  const [directoryName, setDirectoryName] = useState<string>('');
  const [needsDirectoryPermission, setNeedsDirectoryPermission] = useState<boolean>(false);
  const dirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);

  const scanDirectory = async (handle: FileSystemDirectoryHandle): Promise<Cartucho[]> => {
    const list: Cartucho[] = [];
    try {
      for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
          const nameLower = entry.name.toLowerCase();
          if (
            nameLower.endsWith('.nes') ||
            nameLower.endsWith('.md') ||
            nameLower.endsWith('.bin') ||
            nameLower.endsWith('.sms') ||
            nameLower.endsWith('.gba') ||
            nameLower.endsWith('.gbc') ||
            nameLower.endsWith('.gb') ||
            nameLower.endsWith('.n64') ||
            nameLower.endsWith('.z64')
          ) {
            const cleanTitle = entry.name.replace(/\.[^/.]+$/, ""); // strip extension
            const fileConsole = getConsoleTypeAndCore(entry.name).console as any;
            list.push({
              id: `dir-${entry.name}`,
              title: cleanTitle,
              console: fileConsole,
              url: 'directory',
              coverUrl: '',
              customName: entry.name
            });
          }
        }
      }
    } catch (error) {
      console.error('Erro ao escanear diretório:', error);
    }
    return list;
  };

  const handleLinkDirectory = async () => {
    if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
      setToast({
        message: 'Seu navegador não suporta a API de Acesso ao Sistema de Arquivos. Use o Google Chrome ou Microsoft Edge.',
        type: 'error'
      });
      return;
    }
    try {
      audio.playBeep();
      const handle = await (window as any).showDirectoryPicker();
      if (!handle) return;

      dirHandleRef.current = handle;
      setDirectoryName(handle.name);
      setNeedsDirectoryPermission(false);

      // Save persistent reference to IndexedDB database MLegacyDirectoryDB
      await saveDirectoryHandle(handle);

      const scannedGames = await scanDirectory(handle);
      
      setGames(prev => {
        const filtered = prev.filter(g => g.url !== 'directory');
        return [...filtered, ...scannedGames];
      });

      setToast({
        message: `Pasta "${handle.name}" vinculada com sucesso! ${scannedGames.length} jogo(s) inseridos na estante!`,
        type: 'success'
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('Seleção de diretório cancelada.');
        return;
      }
      console.error('Erro ao selecionar pasta:', err);
      setToast({
        message: 'Erro ao vincular pasta local: ' + err.message,
        type: 'error'
      });
    }
  };

  const handleRequestDirectoryPermission = async () => {
    const handle = dirHandleRef.current;
    if (!handle) return;
    try {
      audio.playBeep();
      const options = { mode: 'read' as const };
      const permissionStatus = await handle.requestPermission(options);
      if (permissionStatus === 'granted') {
        setNeedsDirectoryPermission(false);
        const scannedGames = await scanDirectory(handle);
        setGames(prev => {
          const filtered = prev.filter(g => g.url !== 'directory');
          return [...filtered, ...scannedGames];
        });
        setToast({
          message: `Pasta "${handle.name}" ativada! ${scannedGames.length} jogo(s) carregados com sucesso!`,
          type: 'success'
        });
      } else {
        setToast({
          message: 'Permissão de leitura negada para a pasta local.',
          type: 'error'
        });
      }
    } catch (err: any) {
      console.error('Erro de permissão da pasta:', err);
      setToast({
        message: 'Falha de autenticação: ' + err.message,
        type: 'error'
      });
    }
  };

  const handleUnlinkDirectory = async () => {
    try {
      audio.playBeep();
      await deleteDirectoryHandle();
      dirHandleRef.current = null;
      setDirectoryName('');
      setNeedsDirectoryPermission(false);
      
      // Remove all directory backed games from state
      setGames(prev => prev.filter(g => g.url !== 'directory'));
      
      const currentRom = selectedRom;
      const isRomFromDir = games.some(g => g.id === currentRom && g.url === 'directory');
      if (isRomFromDir) {
        const remaining = games.filter(g => g.url !== 'directory');
        if (remaining.length > 0) {
          setSelectedRom(remaining[0].id);
          const { layout } = getConsoleTypeAndCore(remaining[0].customName || remaining[0].id);
          setControllerLayout(layout);
        } else {
          setSelectedRom('');
        }
      }

      setToast({
        message: 'Pasta desvinculada com sucesso!',
        type: 'success'
      });
    } catch (err: any) {
      console.error('Erro ao desvincular pasta de jogos:', err);
    }
  };

  // Estados de notificações e confirmações livres de APIs iframe bloqueantes
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'warning' } | null>(null);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Carrega diretório vinculado no IndexedDB na inicialização
  useEffect(() => {
    let active = true;
    const initDirectory = async () => {
      const isDirectoryPickerSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
      if (!isDirectoryPickerSupported) return;
      try {
        const handle = await getDirectoryHandle();
        if (!active) return;
        if (handle) {
          dirHandleRef.current = handle;
          setDirectoryName(handle.name);

          // Verifica se já temos a permissão ativa de forma silenciosa
          const options = { mode: 'read' as const };
          const permissionStatus = await handle.queryPermission(options);
          if (permissionStatus === 'granted') {
            const scannedGames = await scanDirectory(handle);
            if (!active) return;
            setGames(prev => {
              const filtered = prev.filter(g => g.url !== 'directory');
              return [...filtered, ...scannedGames];
            });
          } else {
            // Se precisar de permissão por interação do usuário, altera o estado para alertar no painel
            setNeedsDirectoryPermission(true);
          }
        }
      } catch (err) {
        console.error('Erro ao inicializar diretório do IndexedDB:', err);
      }
    };
    initDirectory();
    return () => {
      active = false;
    };
  }, []);

  // Carrega ROMs salvas no IndexedDB na inicialização
  useEffect(() => {
    let active = true;
    const loadStoredRoms = async () => {
      try {
        const stored = await getAllRomsFromIndexedDB();
        if (!active) return;
        if (stored && stored.length > 0) {
          const loadedCartridges: Cartucho[] = stored.map(rom => {
            const cleanTitle = rom.nome.replace(/\.[^/.]+$/, ""); // Remove extensão
            return {
              id: rom.id,
              title: cleanTitle,
              console: rom.tipo as any,
              url: 'custom',
              coverUrl: '',
              customBlob: rom.data,
              customName: rom.nome
            };
          });
          setGames(prev => {
            // Remove duplicados antes de concatenar para segurança
            const filtered = prev.filter(g => !loadedCartridges.some(loaded => loaded.id === g.id || (g.customName && loaded.customName === g.customName)));
            return [...filtered, ...loadedCartridges];
          });
        }
      } catch (err) {
        console.error('Erro ao carregar ROMs do IndexedDB na inicialização:', err);
      }
    };
    loadStoredRoms();
    return () => {
      active = false;
    };
  }, []);

  // Estados do Emulador NES / Mega Drive
  const [isEmulatorActive, setIsEmulatorActive] = useState<boolean>(false);
  const [isEmulatorLoading, setIsEmulatorLoading] = useState<boolean>(false);
  const [emulatorStateText, setEmulatorStateText] = useState<string>('Desligado');
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [controllerLayout, setControllerLayout] = useState<string>('nes');
  const controllerLayoutRef = useRef<string>('nes');

  // Refs de Sincronização em Tempo Real (Evita Stale Closures nos Eventos de Sockets e Teclado)
  const selectedRomRef = useRef<string>(selectedRom);
  const gamesListRef = useRef<Cartucho[]>(games);
  const isEmulatorActiveRef = useRef<boolean>(isEmulatorActive);
  const isEmulatorLoadingRef = useRef<boolean>(isEmulatorLoading);

  useEffect(() => {
    selectedRomRef.current = selectedRom;
  }, [selectedRom]);

  useEffect(() => {
    gamesListRef.current = games;
  }, [games]);

  useEffect(() => {
    isEmulatorActiveRef.current = isEmulatorActive;
  }, [isEmulatorActive]);

  useEffect(() => {
    isEmulatorLoadingRef.current = isEmulatorLoading;
  }, [isEmulatorLoading]);

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
  const player2ParticipatedRef = useRef<boolean>(false);

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

  // Monitora alterações de layout do controle e transmite para os controles conectados
  useEffect(() => {
    controllerLayoutRef.current = controllerLayout;
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('change-layout', controllerLayout);
      addLogRef.current(`Layout alternado para: ${controllerLayout === 'nes' ? 'NES (A/B)' : 'Mega Drive (A/B/C)'}`, 'success');
    }
  }, [controllerLayout]);

  // Conecta WebSocket de comunicação
  useEffect(() => {
    if (!roomCode) return;

    const hostname = window.location.origin;
    // Iniciamos com polling de fallback confiável para evitar problemas de proxy / CORS em WebSockets puros
    // Conectamos via caminho relativo para que a requisição seja considerada same-origin, evitando preflight/CORS no iframe do AI Studio.
    const socketInstance = io({
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
      setPlayer1Conectado(false);
      setPlayer2Conectado(false);
      activeControllersRef.current.clear();
      addLogRef.current('Console desconectado do servidor.', 'warn');
    });

    // Eventos do celular vinculados à sala
    socketInstance.on('controller-connected', (data: { id: string; playerNumber: number }) => {
      const { id, playerNumber } = data;
      activeControllersRef.current.set(id, playerNumber);
      
      let p1Now = player1Conectado;
      let p2Now = player2Conectado;

      if (playerNumber === 1) {
        setPlayer1Conectado(true);
        p1Now = true;
      } else if (playerNumber === 2) {
        setPlayer2Conectado(true);
        p2Now = true;
        player2ParticipatedRef.current = true;
      }
      
      audio.playStart();
      addLogRef.current(`Controle Player ${playerNumber} pareado e sintonizado!`, 'success');

      // Envia o layout atualmente ativo para o novo controle se sintonizar automaticamente
      setTimeout(() => {
        if (socketInstance.connected) {
          socketInstance.emit('change-layout', controllerLayoutRef.current);
        }
      }, 400);

      // Se o emulador estiver ativo e pausado, gerencia a retomada inteligente (resume)
      if (nostalgistInstance.current && (nostalgistInstance.current.getStatus() === 'paused' || emulatorStateText.startsWith('Pausado'))) {
        const isMultiplayer = player2ParticipatedRef.current;
        if (isMultiplayer) {
          // No modo Multiplayer, SÓ resume se P1 E P2 estiverem e permanecerem ativos/conectados
          if (p1Now && p2Now) {
            nostalgistInstance.current.resume();
            setEmulatorStateText('Executando jogo');
            addLogRef.current('Ambos os jogadores conectados. Jogo retomado!', 'success');
          } else {
            addLogRef.current('Aguardando reconexão de ambos os jogadores para despausar.', 'info');
          }
        } else {
          // No modo Singleplayer, basta o P1 estar online para retomar
          if (p1Now) {
            nostalgistInstance.current.resume();
            setEmulatorStateText('Executando jogo');
            addLogRef.current('Player 1 reconectado. Jogo retomado!', 'success');
          }
        }
      }
    });

    socketInstance.on('controller-disconnected', (data: { id: string; playerNumber: number }) => {
      const { id, playerNumber } = data;
      activeControllersRef.current.delete(id);
      
      if (playerNumber === 1) {
        setPlayer1Conectado(false);
      } else if (playerNumber === 2) {
        setPlayer2Conectado(false);
      }
      
      audio.playGameOver();
      addLogRef.current(`Controle Player ${playerNumber} desemparelhado.`, 'warn');
      
      // Se qualquer um dos players cair e o jogo estiver executando, pausa e exibe o status de quem caiu
      if (nostalgistInstance.current && nostalgistInstance.current.getStatus() === 'running') {
        const isP1 = playerNumber === 1;
        const isP2 = playerNumber === 2;
        
        // Pausa se o jogador que se desconectou fazia parte da atividade (P1 sempre, P2 apenas se já participou)
        if (isP1 || (isP2 && player2ParticipatedRef.current)) {
          nostalgistInstance.current.pause();
          setEmulatorStateText(`Pausado (Player ${playerNumber} desconectou)`);
          addLogRef.current(`Jogo pausado: Player ${playerNumber} caiu!`, 'warn');
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
        } else {
          // Se o emulador não estiver rodando, o controle navega pelas caixas da estante de locadora
          if (pressed && !isEmulatorLoadingRef.current) {
            const currentGames = gamesListRef.current;
            const currentRom = selectedRomRef.current;
            const currentIndex = currentGames.findIndex(g => g.id === currentRom);
            if (currentIndex !== -1) {
              if (mappedDir === 'left') {
                const nextIndex = (currentIndex - 1 + currentGames.length) % currentGames.length;
                selectGameRef.current(currentGames[nextIndex].id);
              } else if (mappedDir === 'right') {
                const nextIndex = (currentIndex + 1) % currentGames.length;
                selectGameRef.current(currentGames[nextIndex].id);
              }
            }
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
          } else {
            // Se o emulador não estiver ativo, botões A ou START iniciam o jogo
            if (isPressed && !isEmulatorLoadingRef.current) {
              if (mappedButton === 'a' || mappedButton === 'start') {
                const btnPower = document.getElementById('btn-power-on') || document.getElementById('power-on-overlay');
                if (btnPower) {
                  try { (btnPower as any).click(); } catch(e) {}
                }
              }
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

  // Seleção e ativação visual de cartuchos na estante
  const selectGame = (gameId: string) => {
    setSelectedRom(gameId);
    audio.playBeep();

    const game = gamesListRef.current.find(g => g.id === gameId);
    const activeName = (game && game.url === 'custom') ? (game.customName || '') : gameId;
    const { layout } = getConsoleTypeAndCore(activeName);
    setControllerLayout(layout);

    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('change-layout', layout);
      socketRef.current.emit('change-layout', { layout });
      socketRef.current.emit('layout-change', layout);
      socketRef.current.emit('layout-change', { layout });
      socketRef.current.emit('change_layout', { layout });
    }
  };

  const selectGameRef = useRef<(gameId: string) => void>(selectGame);
  useEffect(() => {
    selectGameRef.current = selectGame;
  }, [games]);

  // Navegação por teclado físico (ArrowLeft / ArrowRight para navegar, Enter / Espaço para ligar)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (isEmulatorActiveRef.current || isEmulatorLoadingRef.current) return;

      const currentGames = gamesListRef.current;
      const currentRom = selectedRomRef.current;
      const currentIndex = currentGames.findIndex(g => g.id === currentRom);
      if (currentIndex === -1) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const nextIndex = (currentIndex - 1 + currentGames.length) % currentGames.length;
        selectGameRef.current(currentGames[nextIndex].id);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % currentGames.length;
        selectGameRef.current(currentGames[nextIndex].id);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handlePowerOn();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // Tratador de abertura de confirmação para remoção de jogos da estante
  const handleRemoveClick = (gameId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    audio.playBeep();

    // Verificação de segurança: Não é permitido remover um jogo que está sendo executado no Console!
    if (isEmulatorActiveRef.current && selectedRomRef.current === gameId) {
      setToast({
        message: 'Não é possível remover o jogo em uso! Desative o console antes de excluí-lo.',
        type: 'error'
      });
      return;
    }

    const gameParaRemover = games.find(g => g.id === gameId);
    if (!gameParaRemover) return;

    // Em vez de usar "window.confirm" que é bloqueado por navegadores em sandbox/iframe do AI Studio,
    // atualizamos o estado para abrir o modal arcade customizado
    setConfirmDelete({
      id: gameId,
      title: gameParaRemover.title
    });
  };

  // Executa de fato a deleção após a confirmação no modal
  const confirmarRemocao = () => {
    if (!confirmDelete) return;
    const { id: gameId, title: titulo } = confirmDelete;

    const novaLista = games.filter(g => g.id !== gameId);
    setGames(novaLista);

    // Remove do IndexedDB para se manter persistente no navegador
    deleteRomFromIndexedDB(gameId).catch(err => {
      console.error('Erro ao remover ROM do IndexedDB:', err);
    });

    // Se o jogo deletado for a ROM selecionada, re-seleciona a primeira disponível
    if (selectedRom === gameId) {
      if (novaLista.length > 0) {
        setSelectedRom(novaLista[0].id);
        const activeName = (novaLista[0].url === 'custom') ? (novaLista[0].customName || '') : novaLista[0].id;
        const { layout } = getConsoleTypeAndCore(activeName);
        setControllerLayout(layout);
        if (socketRef.current && socketRef.current.connected) {
          socketRef.current.emit('change-layout', layout);
        }
      } else {
        setSelectedRom('');
      }
    }

    setToast({
      message: `"${titulo}" removido com sucesso da locadora!`,
      type: 'success'
    });
    setConfirmDelete(null);
  };

  // Inicialização do emulador retro nostalgist
  const handlePowerOn = async () => {
    console.log('[Retro Console] Iniciando processo de POWER ON do emulador...');
    // Limpeza de Instância: se houver um nostalgist anterior ativo, destrói antes de dar o launch no novo core
    if (nostalgistInstance.current) {
      console.log('[Retro Console] Instância anterior detectada. Iniciando encerramento...');
      try {
        await nostalgistInstance.current.exit({ removeCanvas: false });
        console.log('[Retro Console] Instância anterior do emulador encerrada com sucesso.');
      } catch (err) {
        console.error('[Retro Console] Erro crítico ao destruir instância anterior:', err);
      }
      nostalgistInstance.current = null;
    }
    setIsEmulatorActive(false);
    isEmulatorActiveRef.current = false;

    if (!canvasRef.current) {
      console.error('[Retro Console] Tentativa de inicialização abortada: elemento canvasRef.current é nulo.');
      return;
    }

    audio.playBeep();
    setIsEmulatorLoading(true);
    setEmulatorStateText('Sincronizando Hardware...');
    player2ParticipatedRef.current = player2Conectado;

    const activeRom = selectedRomRef.current;
    console.log('[Retro Console] Selecionando ROM ativa com ID:', activeRom);
    const game = gamesListRef.current.find(g => g.id === activeRom);
    const activeRomName = (game && (game.url === 'custom' || game.url === 'directory')) ? (game.customName || '') : activeRom;
    const { console: consoleType, layout: romLayout } = getConsoleTypeAndCore(activeRomName);

    const determinarCore = (caminhoRom: string) => {
      const ext = caminhoRom.toLowerCase().split('.').pop();
      if (ext === 'nes') return 'fceumm';
      if (ext === 'gba') return 'mgba';
      if (ext === 'gbc' || ext === 'gb') return 'gambatte';
      if (ext === 'sms') return 'gearsystem';
      if (ext === 'md' || ext === 'bin') return 'genesis_plus_gx';
      if (ext === 'n64' || ext === 'z64') return 'mupen64plus_next';
      return 'fceumm';
    };

    const selectedCore = determinarCore(activeRomName);
    console.log(`[Retro Console] Core determinado: "${selectedCore}" para console: "${consoleType}"`);

    try {
      // Determina arquivo a carregar (ROM de teste local, Blob customizado feito upload, ou leitura direta do HD)
      let romSource: any = activeRom;
      console.log('[Retro Console] Preparando romSource. Tipo de url:', game ? game.url : 'rom nativa');

      if (game && game.url === 'custom' && game.customBlob) {
        console.log('[Retro Console] Jogo customizado do IndexedDB detectado:', game.customName, '- Tamanho da ROM:', game.customBlob.size, 'bytes');
        
        try {
          const extension = activeRomName.toLowerCase().split('.').pop() || 'nes';
          const fileExt = `custom.${extension}`;
          const fileName = game.customName || fileExt;
          
          console.log(`[Retro Console] Criando arquivo virtual de persistência: ${fileName}`);
          const fileObject = new File([game.customBlob], fileName, { type: 'application/octet-stream' });
          
          // Passamos o File object diretamente para o Nostalgist, o que garante a detecção correta da extensão e evita "End of central directory not found"
          romSource = fileObject;
          console.log('[Retro Console] Objeto File criado com sucesso e definido como romSource:', romSource);
        } catch (blobErr) {
          console.error('[Retro Console] Falha ao encapsular em File, tentando URL.createObjectURL direta do Blob de dados:', blobErr);
          romSource = URL.createObjectURL(game.customBlob);
          console.log('[Retro Console] URL de Objeto criada diretamente do Blob puro (Aviso: pode falhar se o emulador exigir extensão física):', romSource);
        }
      } else if (game && game.url === 'directory' && game.customName) {
        console.log('[Retro Console] Lendo arquivo da pasta vinculada:', game.customName);
        const dirHandle = dirHandleRef.current;
        if (!dirHandle) {
          throw new Error('A pasta de jogos vinculada não está ativa ou foi desconectada.');
        }
        console.log('[Retro Console] Checando permissão de leitura para pasta física...');
        const permissionStatus = await dirHandle.queryPermission({ mode: 'read' });
        if (permissionStatus !== 'granted') {
          console.log('[Retro Console] Permissão não concedida previamente. Requisitando autorização ao usuário...');
          const reqStatus = await dirHandle.requestPermission({ mode: 'read' });
          if (reqStatus !== 'granted') {
            throw new Error(`Permissão de leitura negada para a pasta "${dirHandle.name}". Autorize o acesso para iniciar o jogo.`);
          }
        }
        try {
          console.log('[Retro Console] Abrindo handle do arquivo:', game.customName);
          const fileHandle = await dirHandle.getFileHandle(game.customName);
          const f = await fileHandle.getFile();
          console.log('[Retro Console] Arquivo recuperado do HD com sucesso. Tamanho:', f.size, 'bytes');

          // Passamos o File object f diretamente (evitando URL.createObjectURL para não gerar erro de ZIP "End of central directory not found")
          romSource = f;
          console.log('[Retro Console] File object físico atribuído com sucesso à romSource.');
        } catch (fileErr: any) {
          console.error('[Retro Console] Erro ao ler arquivo do HD local:', fileErr);
          throw new Error(`Não foi possível ler o arquivo "${game.customName}" do seu HD. Verifique se ele ainda existe na pasta.`);
        }
      }

      console.log(`[Retro Console] Inicializando Nostalgist [${consoleType.toUpperCase()}] com core [${selectedCore}]. RomSource:`, romSource);

      // Instanciação dinâmica usando a API .launch de Nostalgist para carregar qualquer core retro
      const instance = await Nostalgist.launch({
        core: selectedCore,
        rom: romSource,
        element: canvasRef.current,
        resolveCoreSource(core, ext) {
          const coreUrl = `https://cdn.jsdelivr.net/gh/leizongmin/nostalgist/cores/${core}.${ext}`;
          console.log(`[Retro Console] Baixando Wasm core de: ${coreUrl}`);
          return coreUrl;
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
          input_player1_l: 'q',
          input_player1_r: 'w',
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
          // Otimizações de desempenho para cores mais pesados como N64
          video_vsync: true,
          video_threaded_video: true,
          video_frame_delay: 0,
        }
      });

      console.log('[Retro Console] Nostalgist.launch retornou uma instância com sucesso.');
      nostalgistInstance.current = instance;
      setIsEmulatorActive(true);
      setEmulatorStateText('Executando jogo');

      // Foca automaticamente no canvas do emulador para escutar teclado nativamente também
      canvasRef.current.focus();

    } catch (error) {
      console.error('[Retro Console] FALHA CRÔNICA ao abrir ou executar emulador:', error);
      setEmulatorStateText('Erro de Inicialização');
      const getConsoleName = (type: string) => {
        if (type === 'megadrive') return 'Mega Drive';
        if (type === 'sms') return 'Master System';
        if (type === 'gba') return 'Game Boy Advance';
        if (type === 'gbc') return 'Game Boy Color';
        if (type === 'n64') return 'Nintendo 64';
        return 'NES';
      };
      alert(`Erro ao carregar o emulador de ${getConsoleName(consoleType)}. Verifique se o arquivo está correto.`);
    } finally {
      setIsEmulatorLoading(false);
    }
  };

  // Desativação segura do emulador
  const handlePowerOff = async () => {
    if (!isEmulatorActive || !nostalgistInstance.current) return;

    audio.playBeep();
    console.log('[Retro Console] Desligando console e encerrando instância...');
    try {
      // Método seguro de fechamento e liberação de cache com await
      await nostalgistInstance.current.exit({ removeCanvas: false });
      console.log('[Retro Console] Instância anterior destruída com sucesso.');
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

  // Carrega ROM customizada inserida pelo usuário e sintoniza na estante de locadora
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      const file = files[0];
      const nameLower = file.name.toLowerCase();
      const isValid = nameLower.endsWith('.nes') || nameLower.endsWith('.md') || nameLower.endsWith('.bin') || nameLower.endsWith('.sms') || nameLower.endsWith('.gba') || nameLower.endsWith('.gbc') || nameLower.endsWith('.gb') || nameLower.endsWith('.n64') || nameLower.endsWith('.z64');
      if (!isValid) {
        alert('Por favor, faça upload de um arquivo com extensão válida (.nes, .md, .bin, .sms, .gba, .gbc, .gb, .n64 ou .z64).');
        return;
      }

      const cleanTitle = file.name.replace(/\.[^/.]+$/, ""); // Remove extensão
      const fileConsole = getConsoleTypeAndCore(file.name).console as 'nes' | 'megadrive' | 'sms' | 'gba' | 'gbc' | 'n64';

      // Se o arquivo contendo EXATAMENTE o mesmo nome já estiver na estante, nós atualizamos seu conteúdo no IndexedDB e no estado.
      const existingGame = games.find(g => g.customName === file.name);
      const uniqueId = `custom-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const targetId = existingGame ? existingGame.id : uniqueId;

      // Registra dinamicamente na lista da estante
      const newCustomCartridge: Cartucho = {
        id: targetId,
        title: cleanTitle,
        console: fileConsole,
        url: 'custom',
        coverUrl: '', // Força a renderização do cartucho genérico retro com o título impresso
        customBlob: file,
        customName: file.name
      };

      // Salva no IndexedDB de forma persistente
      const dbRom: StoredRom = {
        id: targetId,
        nome: file.name,
        tipo: fileConsole,
        data: file
      };

      saveRomToIndexedDB(dbRom).catch(err => {
        console.error('Erro ao persistir ROM no IndexedDB:', err);
      });

      setGames(prev => {
        const alreadyExists = prev.some(g => g.customName === file.name);
        if (alreadyExists) {
          return prev.map(g => g.customName === file.name ? { 
            ...g, 
            customBlob: file, 
            title: cleanTitle,
            console: fileConsole 
          } : g);
        }
        return [...prev, newCustomCartridge];
      });

      setSelectedRom(targetId);
      audio.playBeep();

      const { layout } = getConsoleTypeAndCore(file.name);
      setControllerLayout(layout);

      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit('change-layout', layout);
        socketRef.current.emit('change-layout', { layout });
        socketRef.current.emit('layout-change', layout);
        socketRef.current.emit('layout-change', { layout });
        socketRef.current.emit('change_layout', { layout });
      }

      setToast({
        message: `"${cleanTitle}" adicionado à estante!`,
        type: 'success'
      });

      // Limpa para permitir re-upload se desejado
      e.target.value = '';
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
      
      {/* Toast Notification HUD */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 animate-bounce duration-300 pointer-events-none">
          <div className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border shadow-xl shadow-black font-pixel text-[10px] uppercase tracking-wide text-white ${
            toast.type === 'error' 
              ? 'bg-red-950/95 border-red-500 text-red-100' 
              : toast.type === 'success'
              ? 'bg-emerald-950/95 border-emerald-500 text-emerald-100'
              : 'bg-orange-950/95 border-orange-500 text-orange-100'
          }`}>
            <AlertTriangle className="w-4 h-4 animate-pulse flex-shrink-0" />
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {/* Retro Arcade Confirmation Overlay */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border-2 border-red-500 rounded-2xl max-w-sm w-full p-6 shadow-2xl relative overflow-hidden font-mono text-center">
            {/* Scanlines / Retro background effect */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(239,68,68,0.1)_0%,transparent_100%)] pointer-events-none"></div>
            
            <div className="bg-red-500/15 p-3 rounded-full text-red-500 w-fit mx-auto mb-4 border border-red-500/20">
              <Trash2 className="w-8 h-8" />
            </div>

            <h3 className="text-sm font-bold uppercase font-pixel tracking-wider text-red-500 mb-2">
              Remover Jogo?
            </h3>
            
            <p className="text-xs text-slate-300 mb-6 leading-relaxed">
              Você deseja remover o jogo <span className="text-orange-400 font-pixel font-bold">"{confirmDelete.title}"</span> da estante de sua locadora virtual?
            </p>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  audio.playBeep();
                  setConfirmDelete(null);
                }}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-bold font-pixel text-[10px] rounded-lg transition-colors cursor-pointer"
              >
                CANCELAR
              </button>
              
              <button
                onClick={confirmarRemocao}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 hover:scale-102 border border-red-500 text-white font-bold font-pixel text-[10px] rounded-lg transition-transform cursor-pointer shadow-md shadow-red-950"
              >
                SIM, REMOVER
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* HEADER DE CABINE retro_console */}
      <header className="w-full max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center py-4 px-6 border-b border-orange-500/10 gap-4 mt-2">
        <div className="flex items-center gap-3">
          <div className="bg-orange-600 p-2 rounded-lg text-black font-pixel font-bold text-lg animate-pulse">
            🕹️
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-red-500 font-pixel">
              NEVO CONSOLE {controllerLayout === 'megadrive_3' ? 'MEGA DRIVE' : 'NES'}
            </h1>
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

          {/* Card Seletor de Jogos ROM -> ESTANTE DE LOCADORA VIRTUAL */}
          <div className="bg-slate-900 border border-orange-500/10 rounded-2xl p-5 relative shadow-2xl overflow-hidden flex flex-col">
            <div className="absolute top-0 right-0 w-32 h-32 bg-orange-500/5 rounded-full blur-3xl pointer-events-none"></div>
            
            <h4 className="font-bold text-slate-200 uppercase font-pixel tracking-wider text-[10px] text-orange-500 mb-1 flex items-center gap-1.5">
              📼 Estante de Locadora Virtual
            </h4>
            <p className="text-[10px] text-slate-400 font-mono mb-4 leading-relaxed">
              Arraste horizontalmente ou use <kbd className="bg-slate-950 px-1 py-0.5 rounded border border-slate-800 text-orange-400">←</kbd> <kbd className="bg-slate-950 px-1 py-0.5 rounded border border-slate-800 text-orange-400">→</kbd> no teclado ou D-Pad do celular para navegar!
            </p>

            {/* A PRATELEIRA DA LOCADORA (FLEX CONTAINER SCROLLABLE) */}
            <div className="bg-gradient-to-b from-slate-950 to-slate-900 border border-slate-950 rounded-2xl p-4 shadow-inner relative flex flex-col gap-1">
              <div 
                className="flex overflow-x-auto gap-5 pb-5 pt-3 px-2 scrollbar-thin select-none snap-x"
                style={{ scrollbarWidth: 'thin' }}
              >
                {games.length === 0 ? (
                  <div className="w-full py-8 text-center text-slate-400 font-pixel text-xs flex flex-col items-center justify-center gap-2">
                    <span className="text-orange-500">📭 Estante Vazia!</span>
                    <span className="text-[9px] font-mono text-slate-500 max-w-xs leading-normal">
                      Nenhum jogo na locadora. Faça upload de arquivos .sms, .nes, .md, .bin, .gba, .gbc, .gb, .n64 ou .z64 no seletor abaixo para adicionar!
                    </span>
                  </div>
                ) : (
                  games.map((game) => {
                    const isSelected = selectedRom === game.id;
                    
                    return (
                      <div
                        key={game.id}
                        onClick={() => selectGame(game.id)}
                        className="flex-none w-[110px] snap-center cursor-pointer transition-all duration-300 relative group flex flex-col items-center"
                        id={`cartridge-${game.id}`}
                      >
                        {/* Botão de Remover Jogo (Estilo Ícone de Lixeira Miniatura Retro) */}
                        <button
                          onClick={(e) => handleRemoveClick(game.id, e)}
                          className="absolute -top-1.5 -right-1 z-30 bg-red-600 hover:bg-red-500 hover:scale-110 active:scale-95 text-white rounded-full p-1 border border-red-500 shadow-md shadow-black transition-all duration-200 opacity-90 md:opacity-0 md:group-hover:opacity-100"
                          title="Remover Jogo da Locadora"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>

                        {/* CARTUCHO FISICO ESTILO RETRO */}
                      <div 
                        className={`w-full aspect-[2/3] rounded-lg relative overflow-hidden transition-all duration-300 transform flex flex-col ${
                          isSelected 
                            ? 'scale-105 -translate-y-2 ring-2 ring-orange-500 shadow-[0_10px_20px_rgba(249,115,22,0.25)]' 
                            : 'opacity-70 hover:opacity-100 hover:scale-[1.02] shadow-md shadow-black'
                        }`}
                        style={{
                          background: game.console === 'nes'
                            ? 'linear-gradient(135deg, #374151 0%, #111827 100%)' // NES Dark Grey plastic
                            : game.console === 'sms'
                            ? 'linear-gradient(135deg, #2563eb 0%, #0f172a 100%)' // SMS Dark Blue plastic
                            : game.console === 'gba'
                            ? 'linear-gradient(135deg, #0d9488 0%, #0b1510 100%)' // GBA Dark Teal plastic
                            : game.console === 'gbc'
                            ? 'linear-gradient(135deg, #7c3aed 0%, #1e0b36 100%)' // GBC Grape Purple
                            : 'linear-gradient(135deg, #1f2937 0%, #030712 100%)' // MegaDrive Carbon black
                        }}
                      >
                        {/* Clip e Saliências de Plástico do Cartucho */}
                        <div className="w-full h-1.5 bg-black/40 flex justify-between px-2 gap-1 shrink-0">
                          <span className="w-2 h-0.5 bg-black/80 rounded"></span>
                          <span className="w-4 h-0.5 bg-black/80 rounded"></span>
                          <span className="w-2 h-0.5 bg-black/80 rounded"></span>
                        </div>

                        {/* Console Badge Header */}
                        <div className={`w-full text-[7px] font-pixel text-center py-0.5 text-white select-none ${
                          game.console === 'nes' ? 'bg-red-600' :
                          game.console === 'sms' ? 'bg-blue-500' :
                          game.console === 'gba' ? 'bg-teal-600' :
                          game.console === 'gbc' ? 'bg-purple-600' : 'bg-indigo-600'
                        }`}>
                          {game.console === 'nes' ? 'NES SYSTEM' :
                           game.console === 'sms' ? 'MASTER SYS' :
                           game.console === 'gba' ? 'GAMEBOY ADV' :
                           game.console === 'gbc' ? 'GAMEBOY CLR' : 'GENESIS MD'}
                        </div>

                        {/* Adesivo / Cover Art do Cartucho */}
                        <div className="flex-1 m-1.5 rounded bg-slate-950 overflow-hidden relative border border-slate-900 flex flex-col justify-between">
                          {game.coverUrl ? (
                            <img 
                              src={game.coverUrl} 
                              alt={game.title} 
                              className="w-full h-full object-cover select-none pointer-events-none" 
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            /* Cartucho Genérico Placeholder */
                            <div className="w-full h-full bg-gradient-to-br from-slate-900 to-slate-950 flex flex-col justify-between p-2 text-center relative select-none">
                              {/* Console Lines background inside slot */}
                              <div className="absolute inset-0 bg-slate-900/40 opacity-15"></div>
                              <span className={`text-[8px] font-pixel px-1 py-0.5 rounded leading-none max-w-[90%] mx-auto ${
                                game.console === 'nes' ? 'bg-red-600/30 text-red-400' :
                                game.console === 'sms' ? 'bg-blue-600/30 text-blue-400' :
                                game.console === 'gba' ? 'bg-teal-600/30 text-teal-400' :
                                game.console === 'gbc' ? 'bg-purple-600/30 text-purple-400' :
                                'bg-indigo-600/30 text-indigo-400'
                              }`}>
                                {game.console === 'nes' ? 'NES v.1' :
                                 game.console === 'sms' ? 'SMS v.1' :
                                 game.console === 'gba' ? 'GBA v.1' :
                                 game.console === 'gbc' ? 'GBC v.1' :
                                 'MD v.1'}
                              </span>
                              
                              <p className="text-[9px] font-mono leading-[1.1] text-orange-400 font-bold break-words line-clamp-3 select-none">
                                {game.title}
                              </p>

                              <p className="text-[7px] font-pixel text-slate-500 select-none">
                                CUSTOM ROM
                              </p>
                            </div>
                          )}

                          {/* Faixa decorativa vintage */}
                          {game.coverUrl && (
                            <div className="absolute bottom-0 left-0 right-0 bg-black/80 text-[8px] text-orange-400 font-mono py-0.5 px-0.5 truncate text-center">
                              {game.title}
                            </div>
                          )}
                        </div>

                        {/* Rebaixo inferior do chip */}
                        <div className="h-2 w-full bg-slate-900 border-t border-slate-950 flex items-center justify-center shrink-0">
                          <div className="w-4/5 h-0.5 bg-yellow-600/60 rounded"></div>
                        </div>
                      </div>

                      {/* Nome do Jogo & Console Badge no Rodapé */}
                      <p className={`mt-2.5 text-[10px] font-pixel text-center leading-tight truncate w-full ${
                        isSelected ? 'text-orange-400 font-bold' : 'text-slate-400 group-hover:text-slate-200'
                      }`}>
                        {game.title}
                      </p>
                      
                      <span className={`text-[7px] font-pixel mt-1 px-1.5 rounded-sm uppercase tracking-tight py-0.5 ${
                        game.console === 'nes' ? 'bg-red-950/40 text-red-400 border border-red-900/30' :
                        game.console === 'sms' ? 'bg-blue-950/40 text-blue-400 border border-blue-900/30' :
                        game.console === 'gba' ? 'bg-teal-950/40 text-teal-400 border border-teal-900/30' : 
                        game.console === 'gbc' ? 'bg-purple-950/40 text-purple-400 border border-purple-900/30' :
                        game.console === 'n64' ? 'bg-amber-950/40 text-amber-400 border border-amber-900/30' :
                        'bg-indigo-950/40 text-indigo-400 border border-indigo-900/30'
                      }`}>
                        {game.console === 'megadrive' ? 'megadrive' : game.console}
                      </span>

                      {/* Indicador triangular de item selecionado */}
                      {isSelected && (
                        <div className="absolute -top-3 text-orange-500 text-xs animate-bounce">
                          ▼
                        </div>
                      )}
                    </div>
                  );
                })
              )}
              </div>

              {/* Wooden Shelf Plate Design */}
              <div className="h-2 w-full bg-gradient-to-r from-amber-900 via-amber-800 to-amber-900 rounded-b border-t border-amber-900/30 shadow-[0_4px_10px_black] relative z-10 flex items-center justify-between px-3">
                <span className="w-1.5 h-1 bg-amber-950 rounded-full"></span>
                <span className="w-1.5 h-1 bg-amber-950 rounded-full"></span>
              </div>
            </div>

            {/* Botão de Upload de cartucho local .nes, .md, .bin, .sms, .gba, .gbc, .gb */}
            <div className="mt-3">
              <input 
                type="file" 
                ref={fileInputRef}
                onChange={handleFileUpload}
                accept=".nes,.md,.bin,.sms,.gba,.gbc,.gb,.n64,.z64"
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-2 bg-slate-950 hover:bg-slate-900 border border-dashed border-slate-800 text-slate-400 rounded hover:text-orange-400 transition-colors flex items-center justify-center gap-1.5 cursor-pointer text-xs font-mono font-bold"
                id="btn-upload-rom"
              >
                <Upload className="w-3.5 h-3.5" />
                Carregar ROM local (.nes, .md, .bin, .sms, .gba, .gbc, .gb, .n64, .z64)
              </button>
            </div>

            {/* Seção da Galeria Local (File System Access API & Directory Folder) */}
            <div className="mt-3 pt-3 border-t border-slate-900/60 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-pixel text-slate-400 flex items-center gap-1 uppercase">
                  <FolderOpen className="w-3.5 h-3.5 text-orange-500" />
                  Pasta de Jogos (Híbrida)
                </span>
                {directoryName && (typeof window !== 'undefined' && 'showDirectoryPicker' in window) && (
                  <span className="text-[9px] font-mono px-2 py-0.5 rounded bg-emerald-950/50 text-emerald-400 border border-emerald-500/10 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    Vinculada: {directoryName}
                  </span>
                )}
              </div>

              {(typeof window !== 'undefined' && 'showDirectoryPicker' in window) ? (
                <>
                  {needsDirectoryPermission ? (
                    <div className="p-3 rounded-lg bg-orange-950/20 border border-orange-500/20 flex flex-col gap-2 text-center">
                      <p className="text-[10px] text-orange-400 font-mono leading-normal">
                        A pasta vinculada foi salva, mas precisa de permissão de leitura temporária para reativar os jogos no navegador.
                      </p>
                      <button
                        onClick={handleRequestDirectoryPermission}
                        className="w-full py-1.5 px-3 bg-orange-500/10 border border-orange-500 text-orange-400 rounded hover:bg-orange-600 hover:text-black font-pixel text-[9px] transition-all cursor-pointer flex items-center justify-center gap-1.5"
                      >
                        <Unlock className="w-3 h-3" />
                        AUTORIZAR ACESSO
                      </button>
                    </div>
                  ) : null}

                  <div className="flex gap-2">
                    <button
                      onClick={handleLinkDirectory}
                      className="flex-1 py-2 bg-slate-950 hover:bg-slate-900 border border-dashed border-slate-800 text-slate-400 rounded hover:text-orange-400 transition-colors flex items-center justify-center gap-1.5 cursor-pointer text-[11px] font-mono font-bold"
                      title="Selecione uma pasta com seus jogos (.nes, .md, .sms, .gba) para jogar direto do HD sem upload!"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      {directoryName ? 'Alterar Pasta' : 'Vincular Pasta'}
                    </button>

                    {directoryName && (
                      <button
                        onClick={handleUnlinkDirectory}
                        className="py-2 px-3 bg-red-950/40 hover:bg-red-900 border border-red-950 text-red-400 rounded hover:text-red-300 transition-colors flex items-center justify-center gap-1 cursor-pointer text-[11px] font-mono font-bold"
                        title="Desvincular pasta de jogos de forma permanente"
                      >
                        <FolderMinus className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="p-3 rounded-lg bg-slate-950/40 border border-slate-900 text-slate-400 font-mono text-[9px] leading-relaxed relative overflow-hidden select-none">
                  <div className="absolute top-0 right-0 w-8 h-8 bg-sky-500/5 rounded-full blur"></div>
                  <span className="text-orange-400 font-pixel font-bold block mb-1">ℹ️ Modo Híbrido Ativo:</span>
                  Leitura direta de diretórios físicos não é suportada neste navegador (Firefox/Safari/Mobile).
                  <span className="text-slate-200 block mt-1.5">
                    Não se preocupe! A sua estante de salvamento persistente funciona <strong className="text-orange-400">100% via IndexedDB</strong>. Use o botão <strong>Carregar ROM local</strong> acima e seus jogos ficarão salvos no navegador para você jogar após o F5!
                  </span>
                </div>
              )}
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
