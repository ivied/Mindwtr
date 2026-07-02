export const WHISPER_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export type WhisperModelOption = {
    id: string;
    fileName: string;
    label: string;
    sha256: string;
    sizeBytes: number;
};

export type ParakeetModelOption = {
    id: string;
    label: string;
    modelDirName: string;
    sha256: string;
    sizeBytes: number;
};

export const WHISPER_MODELS: WhisperModelOption[] = [
    { id: 'whisper-tiny', fileName: 'ggml-tiny.bin', label: 'whisper-tiny', sizeBytes: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' },
    { id: 'whisper-tiny.en', fileName: 'ggml-tiny.en.bin', label: 'whisper-tiny.en', sizeBytes: 77704715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f' },
    { id: 'whisper-base', fileName: 'ggml-base.bin', label: 'whisper-base', sizeBytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
    { id: 'whisper-base.en', fileName: 'ggml-base.en.bin', label: 'whisper-base.en', sizeBytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
    { id: 'whisper-large-v3-turbo', fileName: 'ggml-large-v3-turbo.bin', label: 'whisper-large-v3-turbo', sizeBytes: 1624555275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69' },
];

export const DEFAULT_WHISPER_MODEL = WHISPER_MODELS[0]?.id ?? 'whisper-tiny';

export const PARAKEET_MODELS: ParakeetModelOption[] = [
    {
        id: 'parakeet-tdt-0.6b-v3-int8',
        label: 'Parakeet-TDT-0.6B v3 int8 (experimental)',
        modelDirName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
        sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
        sizeBytes: 670478772,
    },
];

export const DEFAULT_PARAKEET_MODEL = PARAKEET_MODELS[0]?.id ?? 'parakeet-tdt-0.6b-v3-int8';
export const PARAKEET_MODEL_INSTALL_DIR = 'parakeet-model';
export const PARAKEET_REQUIRED_FILES = [
    'encoder.int8.onnx',
    'decoder.int8.onnx',
    'joiner.int8.onnx',
    'tokens.txt',
] as const;

export const OPENAI_SPEECH_MODELS = [
    'gpt-4o-mini-transcribe',
    'gpt-4o-transcribe',
    'whisper-1',
];

export const GEMINI_SPEECH_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
];
