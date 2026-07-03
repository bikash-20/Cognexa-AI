import { z } from 'zod';

/* ---------- Wire schemas (validated at API boundary) ---------- */

export const MessageRole = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof MessageRole>;

export const BrainLayer = z.enum(['simple', 'compound', 'complex', 'reasoning', 'specialist']);
export type BrainLayer = z.infer<typeof BrainLayer>;

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  role: MessageRole,
  content: z.string().min(1).max(20_000),
  created_at: z.string(),
  layer: BrainLayer.optional(),
  sources: z.array(z.string()).nullable().optional()
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  session_id: z.string().uuid().optional(),
  user_name: z.string().min(1).max(60),
  message: z.string().min(1).max(4000),
  history: z.array(ChatMessageSchema).max(40),
  attachment_ids: z.array(z.string().min(1)).max(8).optional()
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const AttachmentSummarySchema = z.object({
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  page_count: z.number().int().nonnegative(),
  char_count: z.number().int().nonnegative(),
  engines: z.array(z.string()),
  had_ocr: z.boolean(),
  warnings: z.array(z.string()),
  created_at: z.string()
});
export type AttachmentSummary = z.infer<typeof AttachmentSummarySchema>;

export const ChatReplySchema = z.object({
  session_id: z.string().uuid(),
  message: ChatMessageSchema,
  layers_used: z.array(z.object({ name: BrainLayer, weight: z.number().min(0).max(1) })),
  degraded: z.boolean().optional(),
  attachments_used: z.array(z.string()).nullable().optional()
});
export type ChatReply = z.infer<typeof ChatReplySchema>;

export const HistoryResponseSchema = z.object({
  sessions: z.array(z.object({
    id: z.string().uuid(),
    title: z.string(),
    updated_at: z.string().datetime(),
    message_count: z.number().int().nonnegative()
  }))
});

export const NameSchema = z.object({ user_name: z.string().min(1).max(60) });

/* ---------- TTS ---------- */
export const TtsRequestSchema = z.object({ text: z.string().min(1).max(2000), voice: z.string().optional() });
export type TtsRequest = z.infer<typeof TtsRequestSchema>;
