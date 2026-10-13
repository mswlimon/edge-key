import type { PrismaClient } from "../../generated/prisma/client";
import { listHomeCategories, listHomeProductsPaged } from "../../modules/catalog/queries";
import { getPublicSiteInfo } from "../../modules/site/service";

export type Data = Awaited<ReturnType<typeof data>>;

export async function data(pageContext: { prisma: PrismaClient }) {
  const [site, categories, { items, total }] = await Promise.all([
    getPublicSiteInfo(pageContext.prisma),
    listHomeCategories(pageContext.prisma),
    listHomeProductsPaged(pageContext.prisma, { skip: 0, take: 16 }),
  ]);

  return {
    site,
    catalog: {
      categories,
      products: items,
      total,
    },
  };
}
