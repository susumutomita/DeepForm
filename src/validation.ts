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

export const appFeedbackSchema = z.object({
  type: z.enum(["bug", "feature", "other"]),
  message: z.string().min(1, "メッセージを入力してください").max(5000, "メッセージは5000文字以内で入力してください"),
  page: z.string().max(200).optional(),
});

export const exportIssuesSchema = z.object({
  repoOwner: z.string().min(1, "リポジトリオーナーを入力してください").max(100),
  repoName: z.string().min(1, "リポジトリ名を入力してください").max(100),
});

export const createRepoSchema = z.object({
  name: z.string().min(1, "リポジトリ名を入力してください").max(100),
  description: z.string().max(500).optional(),
  isPrivate: z.boolean().optional(),
});
