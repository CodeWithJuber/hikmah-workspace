'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic, Square, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type VoiceWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
/** Whether the browser has an API, read as external state.
 *
 * It cannot be read while rendering on the server and it never changes once
 * read, so an effect that sets state would paint the unsupported button once on
 * every load for no reason. The server snapshot is `false` because a server has
 * no microphone and no speech synthesiser, and a disabled control is the honest
 * thing to render before the browser says otherwise. */
function capability(present: () => boolean) {
  return {
    subscribe: () => () => {},
    get: present,
    server: () => false,
  };
}

const dictation = capability(() => {
  const w = window as VoiceWindow;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
});
const synthesis = capability(() => 'speechSynthesis' in window);

export function VoiceInput({
  onText,
  disabled,
}: {
  onText: (text: string) => void;
  disabled: boolean;
}) {
  const supported = useSyncExternalStore(dictation.subscribe, dictation.get, dictation.server);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  // Held in a ref and refreshed in an effect rather than during render: a
  // recogniser started three seconds ago must call whatever the current handler
  // is, and writing a ref while rendering is not something React guarantees.
  const callback = useRef(onText);
  useEffect(() => {
    callback.current = onText;
  }, [onText]);
  useEffect(() => {
    return () => {
      if (recognition.current) {
        recognition.current.onresult = null;
        recognition.current.onend = null;
        recognition.current.onerror = null;
        recognition.current.abort();
      }
    };
  }, []);
  useEffect(() => {
    if (disabled) recognition.current?.abort();
  }, [disabled]);
  const start = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const w = window as VoiceWindow;
    const Constructor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Constructor) {
      toast('Dictation is not supported by this browser.');
      return;
    }
    const r = new Constructor();
    recognition.current = r;
    r.lang = navigator.language || 'en-US';
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => {
      const text = Array.from(e.results)
        .map((row) => row[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (text) callback.current(text);
    };
    r.onerror = (e) =>
      toast.error(
        e.error === 'not-allowed'
          ? 'Microphone permission was not granted.'
          : 'Dictation could not complete: ' + e.error,
      );
    r.onend = () => {
      setListening(false);
      recognition.current = null;
    };
    try {
      r.start();
      setListening(true);
      toast(
        'Browser dictation started. Your browser may use its speech service. Review the text before sending.',
      );
    } catch {
      setListening(false);
      toast.error('Could not start dictation.');
    }
  };
  return (
    <Button
      variant="ghost"
      className={'icon-button voice-control' + (listening ? ' active' : '')}
      aria-label={listening ? 'Stop dictation' : 'Dictate message'}
      disabled={disabled || !supported}
      title={
        supported
          ? 'Dictate with your browser speech service'
          : 'Dictation unavailable in this browser'
      }
      onClick={start}
    >
      {listening ? <Square size={16} /> : <Mic size={20} />}
    </Button>
  );
}
export function ReadAloud({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  const supported = useSyncExternalStore(synthesis.subscribe, synthesis.get, synthesis.server);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(() => {
    return () => {
      if (utterance.current) {
        utterance.current.onend = null;
        utterance.current.onerror = null;
        window.speechSynthesis.cancel();
      }
    };
  }, []);
  const speak = () => {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(
      text
        .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
        .replace(/[#*_`]/g, '')
        .slice(0, 12000),
    );
    u.lang = navigator.language;
    u.onend = u.onerror = () => {
      setSpeaking(false);
      utterance.current = null;
    };
    utterance.current = u;
    setSpeaking(true);
    window.speechSynthesis.speak(u);
  };
  return (
    <Button
      className="icon-button"
      variant="ghost"
      title="Read up to 12,000 characters aloud; code blocks omitted"
      aria-label={speaking ? 'Stop reading aloud' : 'Read answer aloud'}
      disabled={!supported || !text}
      onClick={speak}
    >
      {speaking ? <Square size={16} /> : <Volume2 size={16} />}
    </Button>
  );
}
