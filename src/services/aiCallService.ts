import { prisma } from '../utils/db';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.3-70b-versatile was retired/unavailable on this account (verified
// live against GET /v1/models, which no longer lists it at all) — every
// live-call and post-call-analysis request was silently failing with a 400
// until this was caught. gpt-oss-120b is the most capable chat model this
// key currently has access to; re-check `GET /v1/models` if this ever
// starts failing again rather than guessing at another name.
const MODEL = 'openai/gpt-oss-120b';

const getApiKey = () => {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY environment variable is not defined.');
  return key;
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PostCallAnalysis {
  summary: string;
  outcomeTag: 'BOOKED' | 'ANSWERED' | 'ESCALATED';
  customerName?: string;
  unansweredQuestions: string[];
}

/**
 * Dynamically builds AI System Prompt from database KnowledgeBase & EscalationRules
 */
export async function buildSystemPrompt(businessId: string): Promise<string> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      knowledgeBase: true,
      escalationRules: true,
    },
  });

  if (!business) throw new Error(`Business with ID ${businessId} not found.`);

  const kbContext = business.knowledgeBase
    .map((item) => `Q: ${item.question}\nA: ${item.answer}`)
    .join('\n\n');

  const escalationContext = business.escalationRules
    .filter((rule) => rule.askOwner)
    .map((rule) => `- ${rule.topic}: ${rule.description || 'Escalate to owner'}`)
    .join('\n');

  return `You are an AI receptionist representing "${business.name}" (${business.type}).
Timezone: ${business.timezone}
Hours & Services Details: ${business.hoursAndServices || 'Standard business hours'}

=== KNOWLEDGE BASE ===
${kbContext || 'No custom FAQ defined yet.'}

=== ESCALATION RULES ===
When to tell caller you must escalate to staff:
${escalationContext || 'Escalate if caller asks for owner or human directly.'}

=== INSTRUCTIONS ===
- Answer concisely, warmly, and accurately.
- Use only facts from the knowledge base or hours details.
- If you do not know an answer, politely inform caller that staff will follow up.`;
}

/**
 * 1. Speed-Critical Live Voice / Text Turn Generation
 */
export async function generateLiveResponse(
  businessId: string,
  messages: ChatMessage[]
): Promise<string> {
  const systemPrompt = await buildSystemPrompt(businessId);

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.6,
      max_tokens: 250,
      // gpt-oss-120b is a reasoning model: without this, it can spend its
      // entire max_tokens budget on hidden chain-of-thought and return an
      // EMPTY message.content with finish_reason "length" — silently, no
      // error. "low" keeps latency down and leaves enough budget for an
      // actual spoken reply, which is what a live call needs.
      reasoning_effort: 'low',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Groq call generation failed');
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

/**
 * 2. Post-Call Processing: Summarizes transcript, extracts unanswered bottleneck questions,
 * and saves CallLog + BottleneckQuestions directly to Prisma DB.
 */
export async function processAndSaveCallLog(params: {
  businessId: string;
  customerPhone: string;
  transcript: string;
  durationSeconds: number;
}) {
  const { businessId, customerPhone, transcript, durationSeconds } = params;

  // 1. Find or create Customer record
  let customer = await prisma.customer.findFirst({
    where: { businessId, phone: customerPhone },
  });

  // 2. Analyze Call Transcript using Groq JSON Mode
  const analysisPrompt = `Analyze the following customer call transcript and extract structured results.
Return ONLY valid JSON with this format:
{
  "summary": "Brief 2-3 sentence summary of what was discussed",
  "outcomeTag": "BOOKED" | "ANSWERED" | "ESCALATED",
  "customerName": "Extracted customer name if mentioned, otherwise null",
  "unansweredQuestions": ["List any specific question asked by caller that AI couldn't fully answer"]
}`;

  const groqResponse = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: analysisPrompt },
        { role: 'user', content: `Transcript:\n${transcript}` },
      ],
    }),
  });

  const groqData = await groqResponse.json();
  const analysis: PostCallAnalysis = JSON.parse(groqData.choices[0]?.message?.content);

  // Update customer name if discovered and not set
  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        businessId,
        phone: customerPhone,
        name: analysis.customerName || 'Unknown Caller',
      },
    });
  } else if (analysis.customerName && customer.name === 'Unknown Caller') {
    await prisma.customer.update({
      where: { id: customer.id },
      data: { name: analysis.customerName },
    });
  }

  // 3. Save Call Log to Database
  const callLog = await prisma.callLog.create({
    data: {
      businessId,
      customerId: customer.id,
      durationSeconds,
      outcomeTag: analysis.outcomeTag,
      transcript,
      summary: analysis.summary,
    },
  });

  // 4. Save any Unanswered Questions as BottleneckQuestions for follow-up
  if (analysis.unansweredQuestions && analysis.unansweredQuestions.length > 0) {
    await prisma.bottleneckQuestion.createMany({
      data: analysis.unansweredQuestions.map((q) => ({
        businessId,
        customerId: customer.id,
        callId: callLog.id,
        question: q,
        status: 'PENDING',
      })),
    });
  }

  return { callLog, analysis };
}