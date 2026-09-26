/* eslint-disable no-var */
// Minimal Web Speech API typings (not in lib.dom).
interface SpeechRecognitionAlternative { transcript: string; confidence: number }
interface SpeechRecognitionResult { readonly isFinal: boolean; readonly length: number; [i: number]: SpeechRecognitionAlternative }
interface SpeechRecognitionResultList { readonly length: number; [i: number]: SpeechRecognitionResult }
interface SpeechRecognitionEvent extends Event { readonly resultIndex: number; readonly results: SpeechRecognitionResultList }
interface SpeechRecognitionErrorEvent extends Event { readonly error: string; readonly message: string }
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
declare var SpeechRecognition: { prototype: SpeechRecognition; new (): SpeechRecognition };
declare var webkitSpeechRecognition: { prototype: SpeechRecognition; new (): SpeechRecognition };
