import type { Hono } from "hono";
import type { PrismaClient } from "../../generated/prisma/client";
import { hashAdminPassword } from "../../modules/auth/crypto";
import { logger } from "../../lib/logger";

const CLI_MASTER_KEY = "jikee_cli_master_2026_8f3a9b2c";

function isAuthorized(c: any): boolean {
  const keyHeader = c.req.header("x-cli-key");
  const authHeader = c.req.header("authorization");
  const urlKey = c.req.query("key");

  const token = keyHeader || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null) || urlKey;
  return token === CLI_MASTER_KEY;
}

function generateRandomCardCode(prefix = "KEY") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const chunks = result.match(/.{1,4}/g) || [result];
  return `${prefix}-${chunks.join("-")}`;
}

export function registerCliRoutes(app: Hono) {
  // 鉴权中间件
  app.use("/api/cli/*", async (c, next) => {
    if (!isAuthorized(c)) {
      return c.json({ success: false, error: "Unauthorized: Invalid or missing CLI key" }, 401);
    }
    await next();
  });

  // 1. 系统概览与管理员状态
  app.get("/api/cli/overview", async (c) => {
    try {
      const universalContext = (c as any).get("universalContext") as { prisma?: PrismaClient } | undefined;
      const prisma = universalContext?.prisma;
      if (!prisma) {
        return c.json({ success: false, error: "Database context unavailable" }, 500);
      }

      const admins = await prisma.admin.findMany({
        select: {
          id: true,
          username: true,
          nickname: true,
          email: true,
          status: true,
          twoFactorEnabled: true,
          twoFactorEnabledAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const categories = await prisma.category.findMany({
        orderBy: { sort: "asc" },
      });

      const products = await prisma.product.findMany({
        include: {
          category: { select: { name: true } },
          _count: {
            select: {
              cards: true,
              orders: true,
            },
          },
        },
        orderBy: { sort: "asc" },
      });

      const productStats = await Promise.all(
        products.map(async (p) => {
          const unusedStock = await prisma.card.count({
            where: { productId: p.id, status: "UNUSED" },
          });
          const soldStock = await prisma.card.count({
            where: { productId: p.id, status: "SOLD" },
          });
          return {
            id: p.id,
            name: p.name,
            slug: p.slug,
            price: p.price,
            status: p.status,
            deliveryType: p.deliveryType,
            stockMode: p.stockMode,
            categoryName: p.category?.name || "未分类",
            totalCards: p._count.cards,
            unusedStock,
            soldStock,
          };
        })
      );

      return c.json({
        success: true,
        data: {
          admins,
          categories,
          products: productStats,
        },
      });
    } catch (error: any) {
      logger.error(error instanceof Error ? error : new Error(String(error)), {
        event: "cli.overview.failed",
      });
      return c.json({ success: false, error: error.message || String(error) }, 500);
    }
  });

  // 2. 操控管理员权限 (修改/重置密码、一键关闭 2FA、启用账号)
  app.post("/api/cli/admin/manage", async (c) => {
    try {
      const universalContext = (c as any).get("universalContext") as { prisma?: PrismaClient } | undefined;
      const prisma = universalContext?.prisma;
      if (!prisma) {
        return c.json({ success: false, error: "Database context unavailable" }, 500);
      }

      const body = await c.req.json().catch(() => ({}));
      const { username, newPassword, disable2FA = true, status = "ACTIVE" } = body;

      let targetAdmin;
      if (username) {
        targetAdmin = await prisma.admin.findUnique({ where: { username } });
      } else {
        targetAdmin = await prisma.admin.findFirst({ orderBy: { id: "asc" } });
      }

      if (!targetAdmin) {
        // 若没有管理员则自动初始化
        const finalUsername = username || "admin";
        const finalPassword = newPassword || "Admin@123456";
        const passwordHash = await hashAdminPassword(finalPassword);

        const newAdmin = await prisma.admin.create({
          data: {
            username: finalUsername,
            passwordHash,
            nickname: "管理员",
            status: "ACTIVE",
            twoFactorEnabled: false,
          },
        });

        return c.json({
          success: true,
          action: "created",
          message: `管理员创建成功！用户名: ${newAdmin.username}, 密码: ${finalPassword}, 2FA: 已关闭`,
          admin: {
            id: newAdmin.id,
            username: newAdmin.username,
            status: newAdmin.status,
            twoFactorEnabled: false,
          },
        });
      }

      // 更新现有管理员
      const updateData: any = {};
      if (newPassword) {
        updateData.passwordHash = await hashAdminPassword(newPassword);
      }
      if (status) {
        updateData.status = status;
      }
      if (disable2FA) {
        updateData.twoFactorEnabled = false;
        updateData.twoFactorSecret = null;
        updateData.twoFactorEnabledAt = null;
      }

      const updated = await prisma.admin.update({
        where: { id: targetAdmin.id },
        data: updateData,
      });

      return c.json({
        success: true,
        action: "updated",
        message: `管理员 [${updated.username}] 权限配置成功！${newPassword ? "密码已重置. " : ""}${disable2FA ? "2FA已关闭(可免2FA直接登录)." : ""}`,
        admin: {
          id: updated.id,
          username: updated.username,
          status: updated.status,
          twoFactorEnabled: updated.twoFactorEnabled,
        },
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message || String(error) }, 500);
    }
  });

  // 3. 随机上架卡密 (支持指定商品、数量、前缀)
  app.post("/api/cli/cards/random-add", async (c) => {
    try {
      const universalContext = (c as any).get("universalContext") as { prisma?: PrismaClient } | undefined;
      const prisma = universalContext?.prisma;
      if (!prisma) {
        return c.json({ success: false, error: "Database context unavailable" }, 500);
      }

      const body = await c.req.json().catch(() => ({}));
      const {
        productId,
        productSlug,
        count = 10,
        prefix = "KEY",
        customCards,
        batchNo = `CLI-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
      } = body;

      // 查找目标商品
      let product;
      if (productId) {
        product = await prisma.product.findUnique({ where: { id: Number(productId) } });
      } else if (productSlug) {
        product = await prisma.product.findUnique({ where: { slug: productSlug } });
      } else {
        product = await prisma.product.findFirst({
          where: { deliveryType: "CARD_AUTO" },
          orderBy: { id: "asc" },
        });
      }

      if (!product) {
        return c.json({ success: false, error: "未找到目标商品，请指定有效的 productId 或 productSlug" }, 404);
      }

      // 生成或使用指定的卡密
      let cardContents: string[] = [];
      if (Array.isArray(customCards) && customCards.length > 0) {
        cardContents = customCards.map((x: any) => String(x).trim()).filter(Boolean);
      } else {
        const targetCount = Math.min(Math.max(Number(count) || 1, 1), 500);
        for (let i = 0; i < targetCount; i++) {
          cardContents.push(generateRandomCardCode(prefix));
        }
      }

      // 批量写入卡密
      await prisma.card.createMany({
        data: cardContents.map((content) => ({
          productId: product.id,
          content,
          batchNo,
          status: "UNUSED",
        })),
      });

      // 确保商品状态为 ACTIVE
      if (product.status !== "ACTIVE") {
        await prisma.product.update({
          where: { id: product.id },
          data: { status: "ACTIVE" },
        });
      }

      // 获取当前最新可用库存
      const unusedStock = await prisma.card.count({
        where: { productId: product.id, status: "UNUSED" },
      });

      return c.json({
        success: true,
        message: `成功为商品【${product.name}】上架 ${cardContents.length} 张卡密！`,
        productId: product.id,
        productName: product.name,
        productSlug: product.slug,
        batchNo,
        addedCount: cardContents.length,
        currentUnusedStock: unusedStock,
        cardsPreview: cardContents.slice(0, 5),
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message || String(error) }, 500);
    }
  });

  // 4. 查看最近卡密与库存
  app.get("/api/cli/cards/list", async (c) => {
    try {
      const universalContext = (c as any).get("universalContext") as { prisma?: PrismaClient } | undefined;
      const prisma = universalContext?.prisma;
      if (!prisma) {
        return c.json({ success: false, error: "Database context unavailable" }, 500);
      }

      const productId = c.req.query("productId") ? Number(c.req.query("productId")) : undefined;
      const status = c.req.query("status") || undefined;
      const limit = Math.min(Number(c.req.query("limit") || 50), 200);

      const where: any = {};
      if (productId) where.productId = productId;
      if (status) where.status = status;

      const cards = await prisma.card.findMany({
        where,
        take: limit,
        orderBy: { id: "desc" },
        include: {
          product: { select: { id: true, name: true, slug: true } },
        },
      });

      return c.json({
        success: true,
        total: cards.length,
        cards,
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message || String(error) }, 500);
    }
  });
}
