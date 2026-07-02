import { describe, expect, it } from 'vitest';

import {
    DEFAULT_PARAKEET_MODEL,
    PARAKEET_MODELS,
    WHISPER_MODELS,
} from './speech-models';

describe('speech model metadata', () => {
    it('includes Whisper large-v3-turbo as an optional local Whisper model', () => {
        expect(WHISPER_MODELS.find((model) => model.id === 'whisper-large-v3-turbo')).toMatchObject({
            id: 'whisper-large-v3-turbo',
            fileName: 'ggml-large-v3-turbo.bin',
            label: 'whisper-large-v3-turbo',
            sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
            sizeBytes: 1624555275,
        });
    });

    it('includes Parakeet v3 int8 as the desktop experimental local ASR model', () => {
        expect(DEFAULT_PARAKEET_MODEL).toBe('parakeet-tdt-0.6b-v3-int8');
        expect(PARAKEET_MODELS.find((model) => model.id === 'parakeet-tdt-0.6b-v3-int8')).toMatchObject({
            id: 'parakeet-tdt-0.6b-v3-int8',
            label: 'Parakeet-TDT-0.6B v3 int8 (experimental)',
            modelDirName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
            sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
            sizeBytes: 670478772,
        });
    });
});
