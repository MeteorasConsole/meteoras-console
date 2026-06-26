import { z } from 'zod'

const teamRecipientSchema = z.object({
  label: z.string(),
  wallet: z.string(),
  percentOfSupply: z.number(),
  vestingMonths: z.number(),
})

const validationIssueSchema = z.object({
  field: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
})

export const dryRunLaunchRequestSchema = z.object({
  wallet: z.object({
    publicKey: z.string().min(32),
  }).optional(),
  payload: z.object({
    mode: z.literal('dry_run_first'),
    backendFunction: z.literal('create_meteora_dbc_launch'),
    args: z.object({
      token: z.object({
        name: z.string().min(1),
        symbol: z.string().min(1),
        description: z.string(),
        website: z.string(),
        xHandle: z.string(),
        metadataUri: z.string().url().nullable().optional(),
        imageName: z.string().nullable(),
      }),
      curve: z.object({
        quoteAsset: z.enum(['SOL', 'USDC']),
        poolShape: z.enum(['linear', 'exponential']),
        tokenDecimals: z.union([z.literal(6), z.literal(7), z.literal(8), z.literal(9)]),
        totalSupply: z.number().positive(),
        publicFloatPercent: z.number().positive(),
        leftoverPercent: z.number().nonnegative(),
        initialMarketCap: z.number().positive(),
        migrationMarketCap: z.number().positive(),
        feeBps: z.number().min(25),
        optionalSeedBuy: z.number().nonnegative(),
      }),
      leftoverRouting: z.object({
        leftoverReceiver: z.string().min(32),
        developerRewardsPercent: z.number().nonnegative(),
        treasuryPercent: z.number().nonnegative(),
        teamRecipients: z.array(teamRecipientSchema),
      }),
      safety: z.object({
        requiresSimulation: z.literal(true),
        requiresWalletSignature: z.literal(true),
        executeMainnet: z.literal(false),
      }),
    }),
  }),
  clientPlan: z.object({
    totalSupply: z.number().positive(),
    publicFloatTokens: z.number().nonnegative(),
    leftoverTokens: z.number().nonnegative(),
    leftoverPercent: z.number().nonnegative(),
    teamPercent: z.number().nonnegative(),
    initialPrice: z.number().nonnegative(),
    validationIssues: z.array(validationIssueSchema),
  }),
})

export const executeLaunchRequestSchema = z.object({
  dryRunId: z.string().min(1),
  signerWallet: z.string().min(32),
  approvedPayloadHash: z.string().min(16),
  signedTransactionsBase64: z.array(z.string().min(1)).optional(),
})

export const leftoverRouteRequestSchema = z.object({
  receiverWallet: z.string().min(32),
  routePlanHash: z.string().min(16).optional(),
})

export const creatorFeeDryRunRequestSchema = z.object({
  poolAddress: z.string().min(32),
  creatorWallet: z.string().min(32),
  receiverWallet: z.string().min(32),
})

export const metadataUploadRequestSchema = z.object({
  wallet: z.string().min(32).optional(),
  tokenName: z.string().min(1).max(80),
  tokenSymbol: z.string().min(1).max(12),
  description: z.string().max(1_000),
  website: z.string().max(300),
  xHandle: z.string().max(120),
  imageName: z.string().min(1).max(180),
  pinataJwt: z.string().max(8_000).optional(),
  pinataGateway: z.string().max(300).optional(),
  imageDataUrl: z
    .string()
    .min(1)
    .max(12_000_000)
    .refine((value) => /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?;base64,/i.test(value), {
      message: 'imageDataUrl must be a base64 image data URL.',
    }),
})

export const executeCreatorFeeClaimRequestSchema = z.object({
  claimId: z.string().min(1),
  signerWallet: z.string().min(32),
  approvedPayloadHash: z.string().min(16),
  signedTransactionsBase64: z.array(z.string().min(1)).optional(),
})

export const bundlerDryRunRequestSchema = z.object({
  poolAddress: z.string().min(32),
  fundingWallet: z.string().min(32),
  walletCount: z.number().int().min(1).max(100),
  targetSupplyPercent: z.number().positive().max(100),
  slippageBps: z.number().int().min(10).max(5_000).optional(),
})

export const executeBundlerRequestSchema = z.object({
  bundleId: z.string().min(1),
  signerWallet: z.string().min(32),
  approvedPayloadHash: z.string().min(16),
  signedFundingTransactionsBase64: z.array(z.string().min(1)).optional(),
})

export type DryRunLaunchRequest = z.infer<typeof dryRunLaunchRequestSchema>
export type ExecuteLaunchRequest = z.infer<typeof executeLaunchRequestSchema>
export type LeftoverRouteRequest = z.infer<typeof leftoverRouteRequestSchema>
export type CreatorFeeDryRunRequest = z.infer<typeof creatorFeeDryRunRequestSchema>
export type ExecuteCreatorFeeClaimRequest = z.infer<typeof executeCreatorFeeClaimRequestSchema>
export type MetadataUploadRequest = z.infer<typeof metadataUploadRequestSchema>
export type BundlerDryRunRequest = z.infer<typeof bundlerDryRunRequestSchema>
export type ExecuteBundlerRequest = z.infer<typeof executeBundlerRequestSchema>
