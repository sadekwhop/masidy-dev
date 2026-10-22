/**
 * `ask_questions` — lets the Think agent ask the user one or more clarifying
 * questions before it continues building. The tool itself is a no-op inside the
 * ThinkAgent DO: it echoes the questions back as JSON. The host behavior
 * (`ThinkCodingBehavior.translateChunk`) observes the tool output on the same
 * streaming channel used by `set_title` and `deploy_space`, and broadcasts it to
 * the frontend as a `conversation_response.tool` event. The frontend renders a
 * popup; the user's answers come back as the next user message.
 *
 * This tool is only registered for the Think agent.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';

const DESCRIPTION = [
	'Ask the user one or more clarifying questions when the request is underspecified or ambiguous.',
	'',
	'Each question can provide predefined answer options, allow multiple selections, and/or allow a free-text custom answer. The user can also skip the popup entirely.',
	'',
	'Call this tool AT MOST ONCE with all the questions you need answered, then end your turn and wait for the user. Do NOT call this tool if the user has already provided answers or if the product type is already clear.',
].join('\n');

export type ClarifyingQuestion = {
	question: string;
	options?: string[];
	allow_multiple?: boolean;
	allow_custom?: boolean;
};

const QuestionItemSchema = z.union([
	z.string().transform((q) => ({ question: q, options: [], allow_multiple: false, allow_custom: true })),
	z.object({
		question: z.string().optional().default('What would you like to build?'),
		options: z
			.union([
				z.array(z.string()),
				z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
			])
			.optional(),
		allow_multiple: z.boolean().optional(),
		allow_custom: z.boolean().optional(),
	}),
]);

const FlexibleAskQuestionsSchema = z
	.object({
		questions: z.array(QuestionItemSchema).optional(),
		question: z.string().optional(),
		options: z
			.union([
				z.array(z.string()),
				z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
			])
			.optional(),
		allow_multiple: z.boolean().optional(),
		allow_custom: z.boolean().optional(),
	})
	.passthrough()
	.transform((val) => {
		let list: ClarifyingQuestion[] = [];
		if (Array.isArray(val.questions) && val.questions.length > 0) {
			list = val.questions as ClarifyingQuestion[];
		} else if (val.question) {
			list = [
				{
					question: val.question,
					options: Array.isArray(val.options) ? val.options : undefined,
					allow_multiple: val.allow_multiple,
					allow_custom: val.allow_custom,
				},
			];
		}
		return { questions: list };
	});

export function createAskQuestionsTool(): Tool {
	return tool({
		description: DESCRIPTION,
		inputSchema: FlexibleAskQuestionsSchema,
		execute: async (rawArgs: unknown) => {
			const parsed = rawArgs as { questions?: ClarifyingQuestion[] };
			const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
			return JSON.stringify({ ok: true, questions });
		},
	});
}
