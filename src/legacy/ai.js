const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function generateCallSummary(transcript) {
  try {
    const prompt = `
    Analyze the following customer service call transcript for an ElderCare CRM:
    
    TRANSCRIPT:
    "${transcript}"
    
    Please provide a JSON response with the following strictly formatted fields:
    {
      "summary": "A concise 2-sentence summary of the interaction.",
      "actionItems": "A short comma separated list of tasks or follow-ups.",
      "sentiment": "POSITIVE, NEUTRAL, or NEGATIVE",
      "escalationRisk": "LOW, MEDIUM, or HIGH",
      "recommendations": "One sentence suggesting the next best action for the agent."
    }
    
    Respond ONLY with valid JSON.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const result = JSON.parse(response.text);
    return result;
  } catch (error) {
    console.error("AI Generation Error:", error);
    return {
      summary: "Failed to generate summary.",
      actionItems: "None",
      sentiment: "NEUTRAL",
      escalationRisk: "LOW",
      recommendations: "Review call recording manually."
    };
  }
}

async function generateCallSummaryFromAudio(audioUrl, isOutbound) {
  try {
    if (!audioUrl) throw new Error("No audio URL provided");
    
    console.log(`[AI] Fetching audio from ${audioUrl} for processing...`);
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error(`Failed to fetch audio: ${audioRes.statusText}`);
    
    const arrayBuffer = await audioRes.arrayBuffer();
    const base64Audio = Buffer.from(arrayBuffer).toString('base64');
    
    const prompt = `
    Analyze the following customer service call audio for an ElderCare CRM.
    The call is an ${isOutbound ? 'OUTBOUND' : 'INBOUND'} call.
    
    Please provide a JSON response with the following strictly formatted fields:
    {
      "summary": "A detailed chronological summary from call connected to end what they are speaking.",
      "actionItems": "A short comma separated list of tasks or follow-ups.",
      "sentiment": "POSITIVE, NEUTRAL, or NEGATIVE",
      "escalationRisk": "LOW, MEDIUM, or HIGH",
      "recommendations": "One sentence suggesting the next best action for the agent."
    }
    
    Respond ONLY with valid JSON.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [
        {
          inlineData: {
            data: base64Audio,
            mimeType: 'audio/webm'
          }
        },
        prompt
      ],
      config: {
        responseMimeType: "application/json"
      }
    });

    const result = JSON.parse(response.text);
    return result;
  } catch (error) {
    console.error("AI Audio Processing Error:", error);
    return {
      summary: "Failed to generate summary from audio. " + error.message,
      actionItems: "None",
      sentiment: "NEUTRAL",
      escalationRisk: "LOW",
      recommendations: "Review call recording manually."
    };
  }
}

module.exports = { generateCallSummary, generateCallSummaryFromAudio };
