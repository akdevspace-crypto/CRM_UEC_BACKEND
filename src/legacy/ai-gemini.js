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

    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    const response = await ai.models.generateContent({
        model,
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

async function analyzeElderCareEnquiry(transcript, customerContext = '') {
  try {
    const prompt = `
      You are an expert Clinical Intake & Sales AI for ElderCare CRM (ARTIBOTS INNOVATION / Paramantra).
      Analyze the customer conversation transcript and context carefully.
      
      Extract and infer accurate intelligence strictly based on the text. Do NOT fabricate facts. If a detail is missing or not provided, return null or an empty array.
      
      Supported Primary Services for ElderCare:
      - "Assisted Living"
      - "Dementia / Alzheimer's Care"
      - "Post-operative Care"
      - "Palliative Care"
      - "Home Nursing"
      - "Physiotherapy"
      - "Elderly Personal Care"
      - "Medical or Care Consultation"
      - "Pricing and Availability"
      - "Appointment or Facility Visit"
      - "Ambulance / Emergency"
      - "General Service Enquiry"
      - "Complaint or Support"
      
      Supported Enquiry Categories (Must match exact enum):
      - "SERVICE_ENQUIRY"
      - "JOB_ENQUIRY"
      - "VOLUNTEER_ENQUIRY"
      - "DONOR_ENQUIRY"
      - "GENERAL_ENQUIRY"
      - "COMPLAINT_OR_SUPPORT"
      
      Provide a JSON output with the exact structure:
      {
        "enquiryCategory": "SERVICE_ENQUIRY",
        "primaryService": "Assisted Living",
        "subServices": ["24/7 Monitoring", "Medication Management"],
        "confidence": 0.92,
        "priority": "NORMAL", // "LOW", "NORMAL", "MEDIUM", "HIGH", "EMERGENCY"
        "patientName": null,
        "careRecipient": "parent", // "self", "parent", "spouse", "relative", "other", or null
        "patientAge": null,
        "patientConditions": null,
        "patientMobility": null,
        "location": null,
        "urgency": "Immediate", // "Immediate", "Within 1 week", "Within 1 month", "Flexible", or null
        "budget": null,
        "preferredCallbackTime": null,
        "appointmentInterest": false,
        "contactNumber": null, // ONLY if explicitly typed by the customer in conversation! Never infer.
        "missingInfo": ["patient_name", "location", "care_urgency"],
        "suggestedNextQuestion": "Would you like to schedule an assessment visit for your father?",
        "summary": "Customer inquiring about dementia care options for elderly parent in Chennai.",
        "sentiment": "POSITIVE",
        "conversion_probability": 75,
        "recommended_action": "SCHEDULE_FOLLOWUP"
      }
      
      Transcript:
      ${transcript || 'No transcript available.'}
      
      Customer Context:
      ${customerContext || 'No additional context.'}
    `;

    const modelsToTry = [
      process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-pro'
    ];

    let parsed = null;
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            temperature: 0.15
          }
        });
        parsed = JSON.parse(response.text);
        if (parsed) break;
      } catch (mErr) {
        lastError = mErr;
      }
    }

    if (!parsed && lastError) {
      throw lastError;
    }

    if (parsed) {
      if (!Array.isArray(parsed.missingInfo)) parsed.missingInfo = [];
      if (!parsed.contactNumber && !parsed.missingInfo.some(m => m.toLowerCase().includes('phone') || m.toLowerCase().includes('contact'))) {
        parsed.missingInfo.push('contact_number');
      }
      return parsed;
    }
  } catch (error) {
    console.error('Gemini ElderCare Enquiry Analysis Error:', error.message);

    // Heuristic extraction fallback when AI provider is temporarily unavailable
    const lower = (transcript || '').toLowerCase();
    let detectedService = "General Service Enquiry";
    let careRecipient = null;
    if (lower.includes('dementia') || lower.includes('alzheimer')) detectedService = "Dementia / Alzheimer's Care";
    else if (lower.includes('assisted living') || lower.includes('elderly home')) detectedService = "Assisted Living";
    else if (lower.includes('physiotherapy') || lower.includes('physio')) detectedService = "Physiotherapy";
    else if (lower.includes('nursing') || lower.includes('nurse')) detectedService = "Home Nursing";
    else if (lower.includes('palliative')) detectedService = "Palliative Care";

    if (lower.includes('mother') || lower.includes('father') || lower.includes('parent')) careRecipient = 'parent';
    else if (lower.includes('spouse') || lower.includes('husband') || lower.includes('wife')) careRecipient = 'spouse';

    // Safe regex for explicit 10-digit Indian phone numbers
    const phoneMatch = (transcript || '').match(/(?:(?:\+|0{0,2})91[\s-]*)?([6789]\d{9})\b/);
    const extractedPhone = phoneMatch ? phoneMatch[1] : null;

    const missing = ["service_details", "location"];
    if (!extractedPhone) missing.push("contact_number");

    return {
      enquiryCategory: "SERVICE_ENQUIRY",
      primaryService: detectedService,
      subServices: [],
      confidence: 0.7,
      priority: "NORMAL",
      patientName: null,
      careRecipient: careRecipient,
      patientAge: null,
      patientConditions: null,
      patientMobility: null,
      location: null,
      urgency: null,
      budget: null,
      preferredCallbackTime: null,
      appointmentInterest: false,
      contactNumber: extractedPhone,
      missingInfo: missing,
      suggestedNextQuestion: "How can our care team assist your family today?",
      summary: `Enquiry regarding ${detectedService}.`,
      sentiment: "NEUTRAL",
      conversion_probability: 50,
      recommended_action: "NURTURE"
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
        customer: {
          include: { notes: true }
        },
        lead: true
      }
    });
    
    if (!conversation || conversation.messages.length === 0) return;
    
    const transcript = conversation.messages.map(m => `${m.senderType}: ${m.content}`).join('\n');
    const customerNotes = conversation.customer?.notes?.map(n => n.content).join('\n') || '';
    
    // Run deep ElderCare enquiry intelligence
    const intelligence = await analyzeElderCareEnquiry(transcript, customerNotes);
    
    // Save AI Summary
    const aiSummary = await prisma.aiSummary.upsert({
      where: { conversationId },
      update: {
        summaryText: intelligence.summary,
        sentimentScore: intelligence.sentiment,
        riskLevel: intelligence.recommended_action
      },
      create: {
        conversationId,
        summaryText: intelligence.summary,
        sentimentScore: intelligence.sentiment,
        riskLevel: intelligence.recommended_action
      }
    });

    // Safe Conversation Update: Protect agent-confirmed classifications
    const updateData = {};

    // Only update primary classification if agent has not explicitly confirmed it
    if (!conversation.isClassificationConfirmed) {
      if (intelligence.enquiryCategory) {
        // Ensure valid enum value
        const validCategories = [
          'SERVICE_ENQUIRY', 'JOB_ENQUIRY', 'VOLUNTEER_ENQUIRY', 
          'DONOR_ENQUIRY', 'GENERAL_ENQUIRY', 'COMPLAINT_OR_SUPPORT'
        ];
        if (validCategories.includes(intelligence.enquiryCategory)) {
          updateData.enquiryCategory = intelligence.enquiryCategory;
        }
      }
      if (intelligence.primaryService) {
        updateData.primaryService = intelligence.primaryService;
      }
      if (Array.isArray(intelligence.subServices)) {
        updateData.subServices = intelligence.subServices;
      }
      if (typeof intelligence.confidence === 'number') {
        updateData.classificationConfidence = intelligence.confidence;
      }
    }

    if (Array.isArray(intelligence.missingInfo)) {
      updateData.missingInfo = intelligence.missingInfo;
    }

    // Merge intakeMetadata safely
    const existingMeta = (conversation.intakeMetadata && typeof conversation.intakeMetadata === 'object')
      ? conversation.intakeMetadata
      : {};

    const updatedIntakeMetadata = {
      ...existingMeta,
      patientName: existingMeta.patientName || intelligence.patientName || null,
      careRecipient: existingMeta.careRecipient || intelligence.careRecipient || null,
      patientAge: existingMeta.patientAge || intelligence.patientAge || null,
      patientConditions: existingMeta.patientConditions || intelligence.patientConditions || null,
      patientMobility: existingMeta.patientMobility || intelligence.patientMobility || null,
      serviceAddress: existingMeta.serviceAddress || intelligence.location || null,
      urgency: existingMeta.urgency || intelligence.urgency || null,
      budget: existingMeta.budget || intelligence.budget || null,
      preferredCallbackTime: existingMeta.preferredCallbackTime || intelligence.preferredCallbackTime || null,
      appointmentInterest: existingMeta.appointmentInterest || intelligence.appointmentInterest || false,
      suggestedNextQuestion: intelligence.suggestedNextQuestion || null,
      extractedAt: new Date().toISOString()
    };

    // If customer explicitly stated a phone number in conversation, save as candidate contact number
    if (intelligence.contactNumber) {
      updatedIntakeMetadata.extractedContactNumber = intelligence.contactNumber;
      updatedIntakeMetadata.contactNumberSource = 'CUSTOMER_CONVERSATION';
      updatedIntakeMetadata.contactNumberVerified = false;
    }

    updateData.intakeMetadata = updatedIntakeMetadata;

    // Update conversation priority if EMERGENCY
    if (intelligence.priority === 'EMERGENCY' && conversation.priority !== 'EMERGENCY') {
      updateData.priority = 'EMERGENCY';
    }

    const updatedConv = await prisma.conversation.update({
      where: { id: conversationId },
      data: updateData,
      include: { customer: true, lead: true }
    });

    if (io) {
      io.emit('ai_analysis_updated', { 
        customerId: conversation.customerId, 
        conversationId, 
        aiSummary,
        conversation: updatedConv 
      });
      io.emit('conversationUpdated', updatedConv);
      io.emit('omnichannel_intelligence_updated', {
        conversationId,
        intelligence: {
          enquiryCategory: updatedConv.enquiryCategory,
          primaryService: updatedConv.primaryService,
          subServices: updatedConv.subServices,
          confidence: updatedConv.classificationConfidence,
          missingInfo: updatedConv.missingInfo,
          intakeMetadata: updatedConv.intakeMetadata,
          aiSummary
        }
      });
    }
    
    return { aiSummary, updatedConv };
  } catch (err) {
    console.error('Failed to analyze and save conversation:', err);
  }
}

module.exports = {
  analyzeLeadSentiment,
  analyzeElderCareEnquiry,
  analyzeAndSaveConversation
};

