'use strict';

// Quick check that Gemini on Vertex AI is reachable via the Google Gen AI SDK:
// ADC valid, project correct, region physical, Gemini model accessible.
// Run: GCP_PROJECT_ID=<project> node smoke-vertex.js
import { GoogleGenAI } from '@google/genai';

const project = process.env.GCP_PROJECT_ID;
if (!project) {
    console.error('Set GCP_PROJECT_ID first.');
    process.exit(1);
}

const location = process.env.CLOUD_ML_REGION || 'us-central1';
const ai = new GoogleGenAI({ vertexai: true, project, location });

try {
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: vertex ok' }] }]
    });
    console.log('Gemini response:', (response.text ?? '(no text)').trim());
    console.log(`✓ Vertex AI (Gemini) is working — project ${project} @ ${location}.`);
} catch (error) {
    console.error('✗ Vertex call failed:', error.message);
    console.error('\nChecklist: gcloud auth application-default login | Vertex AI API enabled | GCP_PROJECT_ID correct | region is physical (not "global").');
    process.exit(1);
}
