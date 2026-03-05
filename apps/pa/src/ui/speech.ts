export function getSpeechRecognition(): SpeechRecognitionCtor | null {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).SpeechRecognition ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).webkitSpeechRecognition ||
    null
  );
}

export type SpeechRecognitionLike = SpeechRecognition & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
};

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

