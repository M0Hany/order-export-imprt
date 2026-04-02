/** Internal order shape parsed from Shopify Admin order CSV. */

export type ExportedMoneyV1 = {
  amount: string;
  currencyCode: string;
};

export type ExportedAddressV1 = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  company?: string | null;
  country?: string | null;
  countryCode?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
};

export type ExportedLineItemV1 = {
  title: string;
  quantity: number;
  sku?: string | null;
  variantTitle?: string | null;
  vendor?: string | null;
  originalUnitPrice: ExportedMoneyV1;
  discountedUnitPrice?: ExportedMoneyV1 | null;
  requiresShipping?: boolean | null;
  taxable?: boolean | null;
  customAttributes?: { key: string; value: string }[];
};

export type ExportedOrderV1 = {
  sourceId?: string;
  sourceName?: string | null;
  legacyResourceId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  processedAt?: string | null;
  cancelledAt?: string | null;
  closedAt?: string | null;
  currencyCode?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  tags: string[];
  poNumber?: string | null;
  customer?: {
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
  } | null;
  shippingAddress?: ExportedAddressV1 | null;
  billingAddress?: ExportedAddressV1 | null;
  lineItems: ExportedLineItemV1[];
  discountCodes: string[];
  shippingLineTitle?: string | null;
  shippingPrice?: ExportedMoneyV1 | null;
};
