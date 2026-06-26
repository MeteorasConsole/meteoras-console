export type QuoteAsset = 'SOL' | 'USDC'
export type PoolShape = 'linear' | 'exponential'

export type TeamRecipient = {
  id: string
  label: string
  wallet: string
  percentOfSupply: number
  vestingMonths: number
}

export type LaunchForm = {
  tokenName: string
  tokenSymbol: string
  description: string
  website: string
  xHandle: string
  metadataUri: string
  quoteAsset: QuoteAsset
  poolShape: PoolShape
  tokenDecimals: 6 | 7 | 8 | 9
  optionalSeedBuy: number
  totalSupply: number
  publicFloatPercent: number
  developerRewardsPercent: number
  treasuryPercent: number
  initialMarketCap: number
  migrationMarketCap: number
  leftoverReceiver: string
  feeBps: number
  imageName: string
  imagePreview: string
  teamRecipients: TeamRecipient[]
}

export type ValidationIssue = {
  field: string
  message: string
  severity: 'error' | 'warning'
}

export type LaunchPlan = {
  totalSupply: number
  publicFloatTokens: number
  leftoverTokens: number
  leftoverPercent: number
  teamPercent: number
  teamTokens: number
  developerRewardsTokens: number
  treasuryTokens: number
  initialPrice: number
  optionalSeedBuyTokensAtInitialPrice: number
  quoteMintLabel: string
  validationIssues: ValidationIssue[]
}

const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export const defaultLaunchForm: LaunchForm = {
  tokenName: 'Relay Market',
  tokenSymbol: 'RLY',
  description:
    'A team launch using Meteora DBC with a controlled leftover_receiver reserve.',
  website: 'https://relay.market',
  xHandle: '@relaymarket',
  metadataUri: '',
  quoteAsset: 'SOL',
  poolShape: 'linear',
  tokenDecimals: 6,
  optionalSeedBuy: 0,
  totalSupply: 10_000_000,
  publicFloatPercent: 45,
  developerRewardsPercent: 40,
  treasuryPercent: 10,
  initialMarketCap: 5_000,
  migrationMarketCap: 100_000,
  leftoverReceiver: '',
  feeBps: 100,
  imageName: '',
  imagePreview: '',
  teamRecipients: [
    {
      id: 'founders',
      label: 'Founders vest',
      wallet: '',
      percentOfSupply: 3,
      vestingMonths: 24,
    },
    {
      id: 'operators',
      label: 'Operators vest',
      wallet: '',
      percentOfSupply: 2,
      vestingMonths: 18,
    },
  ],
}

export function isLikelySolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS_PATTERN.test(value.trim())
}

export function formatNumber(value: number, maxFractionDigits = 2): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: maxFractionDigits,
  }).format(value)
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1 ? 6 : 0,
  }).format(value)
}

export function getTeamPercent(form: LaunchForm): number {
  return form.teamRecipients.reduce((sum, recipient) => sum + safeNumber(recipient.percentOfSupply), 0)
}

export function buildLaunchPlan(form: LaunchForm): LaunchPlan {
  const validationIssues: ValidationIssue[] = []
  const totalSupply = safeNumber(form.totalSupply)
  const publicFloatPercent = safeNumber(form.publicFloatPercent)
  const developerRewardsPercent = safeNumber(form.developerRewardsPercent)
  const treasuryPercent = safeNumber(form.treasuryPercent)
  const teamPercent = getTeamPercent(form)
  const leftoverPercent = 100 - publicFloatPercent
  const reservedPercent = developerRewardsPercent + treasuryPercent + teamPercent

  if (!form.tokenName.trim()) {
    validationIssues.push(error('tokenName', 'Token name is required.'))
  }
  if (!/^[A-Z0-9]{2,10}$/.test(form.tokenSymbol.trim())) {
    validationIssues.push(error('tokenSymbol', 'Symbol should be 2-10 uppercase letters or numbers.'))
  }
  if (!form.imageName) {
    validationIssues.push(warning('imageName', 'Add an image before production launch.'))
  }
  if (!form.metadataUri.trim()) {
    validationIssues.push(error('metadataUri', 'Metadata URI is required: upload token metadata JSON to Pinata/IPFS and paste the public http(s) gateway URL.'))
  } else if (!/^https?:\/\/.+/i.test(form.metadataUri.trim())) {
    validationIssues.push(error('metadataUri', 'Metadata URI must be a valid http(s) URL.'))
  }
  if (![6, 7, 8, 9].includes(form.tokenDecimals)) {
    validationIssues.push(error('tokenDecimals', 'DBC token decimals must be 6, 7, 8, or 9.'))
  }
  if (!isLikelySolanaAddress(form.leftoverReceiver)) {
    validationIssues.push(error('leftoverReceiver', 'leftover_receiver must be a valid-looking Solana public key.'))
  }
  if (totalSupply <= 0) {
    validationIssues.push(error('totalSupply', 'Total supply must be greater than zero.'))
  }
  if (publicFloatPercent <= 0 || publicFloatPercent >= 100) {
    validationIssues.push(error('publicFloatPercent', 'Public float must be between 1% and 99%.'))
  }
  if (Math.abs(reservedPercent - leftoverPercent) > 0.001) {
    validationIssues.push(
      error(
        'reserveMath',
        `Reserved buckets must equal leftover reserve (${leftoverPercent.toFixed(2)}%). Current reserved sum is ${reservedPercent.toFixed(2)}%.`,
      ),
    )
  }
  if (form.migrationMarketCap <= form.initialMarketCap) {
    validationIssues.push(error('migrationMarketCap', 'Migration market cap must be greater than initial market cap.'))
  }
  if (form.feeBps < 25) {
    validationIssues.push(error('feeBps', 'Meteora DBC pre-graduation base fees should not be below 25 bps.'))
  }
  if (safeNumber(form.optionalSeedBuy) > 0) {
    validationIssues.push(
      error('optionalSeedBuy', 'Optional first buy is planned but not included in generated launch transactions yet. Leave it at 0 for beta launches.'),
    )
  }

  for (const recipient of form.teamRecipients) {
    if (recipient.percentOfSupply > 0 && !isLikelySolanaAddress(recipient.wallet)) {
      validationIssues.push(
        warning(
          `recipient:${recipient.id}`,
          `${recipient.label || 'Team recipient'} needs a wallet before execution.`,
        ),
      )
    }
  }

  const publicFloatTokens = totalSupply * publicFloatPercent / 100
  const leftoverTokens = totalSupply - publicFloatTokens
  const teamTokens = totalSupply * teamPercent / 100
  const developerRewardsTokens = totalSupply * developerRewardsPercent / 100
  const treasuryTokens = totalSupply * treasuryPercent / 100
  const initialPrice = form.initialMarketCap > 0 && totalSupply > 0 ? form.initialMarketCap / totalSupply : 0
  const optionalSeedBuyTokensAtInitialPrice = initialPrice > 0 ? safeNumber(form.optionalSeedBuy) / initialPrice : 0

  return {
    totalSupply,
    publicFloatTokens,
    leftoverTokens,
    leftoverPercent,
    teamPercent,
    teamTokens,
    developerRewardsTokens,
    treasuryTokens,
    initialPrice,
    optionalSeedBuyTokensAtInitialPrice,
    quoteMintLabel: form.quoteAsset === 'SOL' ? 'Native SOL' : 'Mainnet USDC',
    validationIssues,
  }
}

export function buildExecutionPayload(form: LaunchForm) {
  const plan = buildLaunchPlan(form)
  return {
    mode: 'dry_run_first',
    backendFunction: 'create_meteora_dbc_launch',
    args: {
      token: {
        name: form.tokenName.trim(),
        symbol: form.tokenSymbol.trim(),
        description: form.description.trim(),
        website: form.website.trim(),
        xHandle: form.xHandle.trim(),
        metadataUri: form.metadataUri.trim() || null,
        imageName: form.imageName || null,
      },
      curve: {
        quoteAsset: form.quoteAsset,
        poolShape: form.poolShape,
        tokenDecimals: form.tokenDecimals,
        totalSupply: form.totalSupply,
        publicFloatPercent: form.publicFloatPercent,
        leftoverPercent: plan.leftoverPercent,
        initialMarketCap: form.initialMarketCap,
        migrationMarketCap: form.migrationMarketCap,
        feeBps: form.feeBps,
        optionalSeedBuy: form.optionalSeedBuy,
      },
      leftoverRouting: {
        leftoverReceiver: form.leftoverReceiver.trim(),
        developerRewardsPercent: form.developerRewardsPercent,
        treasuryPercent: form.treasuryPercent,
        teamRecipients: form.teamRecipients.map((recipient) => ({
          label: recipient.label,
          wallet: recipient.wallet,
          percentOfSupply: recipient.percentOfSupply,
          vestingMonths: recipient.vestingMonths,
        })),
      },
      safety: {
        requiresSimulation: true,
        requiresWalletSignature: true,
        executeMainnet: false,
      },
    },
  }
}

export function buildCliPreview(form: LaunchForm): string {
  return [
    'POST /api/launches/dry-run',
    JSON.stringify(buildExecutionPayload(form), null, 2),
    '',
    '# after validation and Phantom approval:',
    'POST /api/launches/:id/execute',
    '# after DBC migration:',
    'POST /api/launches/:id/leftover-route',
  ].join('\n')
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function error(field: string, message: string): ValidationIssue {
  return { field, message, severity: 'error' }
}

function warning(field: string, message: string): ValidationIssue {
  return { field, message, severity: 'warning' }
}
