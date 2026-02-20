import { z } from "zod";

export const createSessionSchema = z.object({
  theme: z.string().min(1, "テーマを入力してください").max(500, "テーマは500文字以内で入力してください"),
});

export const chatMessageSchema = z.object({
  message: z.string().min(1, "メッセージを入力してください").max(5000, "メッセージは5000文字以内で入力してください"),
});

export const visibilitySchema = z.object({
  is_public: z.boolean(),
});

export const respondentNameSchema = z.object({
  respondentName: z.string().max(100).optional(),
});

export const feedbackSchema = z.object({
  feedback: z.string().max(5000).optional().nullable(),
});

export const triageSchema = z.object({
  selectedFactIds: z.array(z.string().max(200)).max(500),
});

export const appFeedbackSchema = z.object({
  type: z.enum(["bug", "feature", "other"]),
  message: z.string().min(1, "メッセージを入力してください").max(5000, "メッセージは5000文字以内で入力してください"),
  page: z.string().max(200).optional(),
});
