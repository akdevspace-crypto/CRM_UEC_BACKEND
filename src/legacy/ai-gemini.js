const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function analyzeLeadSentiment(transcript, agentNotes) {
  try {
    const prompt = `
      You are an expert sales AI. Analyze the following conversation transcript and agent notes for a lead.
      Provide a structured JSON output with the following keys:
      - "sentiment": "POSITIVE", "NEGATIVE", or "NEUTRAL"
      - "conversion_probability": A number between 0 and 100.
      - "recommended_action": e.g., "SCHEDULE_FOLLOWUP", "CLOSE", "NURTURE"
      - "summary": A brief 1-2 sentence summary of the lead's interest.

      Transcript:
      ${transcript || 'No transcript available.'}

      Agent Notes:
      ${agentNotes || 'No notes available.'}
    `;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            temperature: 0.2
        }
    });

    const text = response.text;
    const json = JSON.parse(text);
    return json;
  } catch (error) {
    console.error('Gemini AI Analysis Error:', error);
    return {
      sentiment: "NEUTRAL",
      conversion_probability: 50,
      recommended_action: "NURTURE",
      summary: "Failed to analyze sentiment."
    };
  }
}

async function analyzeAndSaveConversation(conversationId, io) {
  try {
    const prisma = require('./prisma');
    
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { 
        messages: { orderBy: { createdAt: 'asc' } },
        customer: true 
      }
    });
    
    if (!conversation || conversation.messages.length === 0) return;
    
    const transcript = conversation.messages.map(m => `${m.senderType}: ${m.content}`).join('\n');
    
    const result = await analyzeLeadSentiment(transcript, conversation.customer?.notes?.map(n => n.content).join('\n') || '');
    
    const aiSummary = await prisma.aiSummary.upsert({
      where: { conversationId },
      update: {
        summaryText: result.summary,
        sentimentScore: result.sentiment,
        riskLevel: result.recommended_action
      },
      create: {
        conversationId,
        summaryText: result.summary,
        sentimentScore: result.sentiment,
        riskLevel: result.recommended_action
      }
    });
    
    if (io) {
      io.emit('ai_analysis_updated', { customerId: conversation.customerId, aiSummary });
    }
    
    return aiSummary;
  } catch (err) {
    console.error('Failed to analyze and save conversation:', err);
  }
}

module.exports = {
  analyzeLeadSentiment,
  analyzeAndSaveConversation
};
