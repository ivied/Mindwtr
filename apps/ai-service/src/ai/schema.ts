/**
 * SGR (Structured Generation Reasoning) schema for GTD classification.
 * Used as OpenAI function calling schema with 9Router.
 */

export const CLASSIFICATION_SCHEMA = {
  type: 'function',
  function: {
    name: 'classify_gtd_item',
    description:
      'Classify a captured item into GTD categories with contexts, tags, and reasoning',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['next', 'waiting', 'someday', 'reference', 'two_minute'],
          description:
            "GTD category: 'next' for actionable single step, 'waiting' for delegated/blocked, 'someday' for maybe later, 'reference' for info only, 'two_minute' for tasks under 2 minutes",
        },
        is_noise: {
          type: 'boolean',
          description:
            'True if this is noise (spam, ads, trivial, nothing to act on). Keep in inbox but flag.',
        },
        noise_reason: {
          type: 'string',
          description: 'Short explanation if is_noise=true',
        },
        suggested_contexts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'GTD contexts: @home, @work, @errands, @phone, @computer, @anywhere. Prefix with @',
        },
        suggested_tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Free-form tags relevant to the task',
        },
        is_project: {
          type: 'boolean',
          description:
            'True if this looks like a multi-step project that should be broken down',
        },
        project_name: {
          type: 'string',
          description: 'Suggested project name if is_project=true',
        },
        is_delegation: {
          type: 'boolean',
          description: 'True if this is about waiting for something from someone',
        },
        delegate_to: {
          type: 'string',
          description: 'Who we are waiting on (if is_delegation=true)',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence in the classification from 0 to 1',
        },
        reasoning: {
          type: 'string',
          description: 'Short (1-2 sentences) explanation of the classification decision',
        },
      },
      required: [
        'category',
        'is_noise',
        'suggested_contexts',
        'suggested_tags',
        'is_project',
        'is_delegation',
        'confidence',
        'reasoning',
      ],
    },
  },
} as const
