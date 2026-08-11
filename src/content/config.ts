import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    category: z.string(),
    coverImage: z.string(),
    excerpt: z.string(),
    updatedDate: z.date().optional(),
    noindex: z.boolean().optional().default(false),
    rating: z.number().min(1).max(5).optional(),
    facilityName: z.string().optional(),
  }),
});

export const collections = { blog };
