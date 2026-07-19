import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    category: z.string(),
    coverImage: z.string(),
    excerpt: z.string(),
    rating: z.number().min(1).max(5).optional().default(5),
    facilityName: z.string().optional(),
  }),
});

export const collections = { blog };
