-- CreateTable
CREATE TABLE "ImportedOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT,
    "sourceName" TEXT,
    "sourceId" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportedOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImportedOrder_shop_orderGid_key" ON "ImportedOrder"("shop", "orderGid");

-- CreateIndex
CREATE INDEX "ImportedOrder_shop_importedAt_idx" ON "ImportedOrder"("shop", "importedAt");
