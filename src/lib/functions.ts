import {
  LaunchForm,
  buildCliPreview,
  buildExecutionPayload,
  buildLaunchPlan,
  formatNumber,
  isLikelySolanaAddress,
} from './launchpad'

export type DeveloperFunctionStatus = 'running' | 'complete' | 'blocked'

export type DeveloperFunctionCall = {
  id: string
  name: string
  label: string
  status: DeveloperFunctionStatus
  args: Record<string, unknown>
  result?: Record<string, unknown>
}

type DeveloperFunction = {
  id: string
  name: string
  label: string
  args: (form: LaunchForm) => Record<string, unknown>
  run: (form: LaunchForm) => Record<string, unknown>
}

const developerFunctions: DeveloperFunction[] = [
  {
    id: 'intent',
    name: 'collect_launch_intent',
    label: 'Read token brief, quote asset, and optional seed buy',
    args: (form) => ({
      tokenName: form.tokenName,
      tokenSymbol: form.tokenSymbol,
      quoteAsset: form.quoteAsset,
      poolShape: form.poolShape,
      tokenDecimals: form.tokenDecimals,
      optionalSeedBuy: form.optionalSeedBuy,
      hasImage: Boolean(form.imageName),
      hasMetadataUri: Boolean(form.metadataUri),
    }),
    run: (form) => ({
      accepted: true,
      brief: `${form.tokenName} (${form.tokenSymbol}) launching against ${form.quoteAsset}.`,
      image: form.imageName || 'missing',
    }),
  },
  {
    id: 'receiver',
    name: 'validate_leftover_receiver',
    label: 'Validate leftover_receiver before reserve assignment',
    args: (form) => ({ leftoverReceiver: form.leftoverReceiver || '<empty>' }),
    run: (form) => {
      const valid = isLikelySolanaAddress(form.leftoverReceiver)
      return {
        valid,
        risk: valid
          ? 'Receiver format is valid-looking. Multisig ownership still needs backend verification.'
          : 'Blocked: leftover_receiver is required before launch execution.',
      }
    },
  },
  {
    id: 'reserve',
    name: 'calculate_leftover_reserve',
    label: 'Calculate public float and leftover reserve',
    args: (form) => ({
      totalSupply: form.totalSupply,
      publicFloatPercent: form.publicFloatPercent,
      developerRewardsPercent: form.developerRewardsPercent,
      treasuryPercent: form.treasuryPercent,
      teamRecipients: form.teamRecipients.length,
    }),
    run: (form) => {
      const plan = buildLaunchPlan(form)
      return {
        publicFloatTokens: formatNumber(plan.publicFloatTokens),
        leftoverTokens: formatNumber(plan.leftoverTokens),
        leftoverPercent: `${plan.leftoverPercent.toFixed(2)}%`,
        teamTokens: formatNumber(plan.teamTokens),
        developerRewardsTokens: formatNumber(plan.developerRewardsTokens),
        treasuryTokens: formatNumber(plan.treasuryTokens),
      }
    },
  },
  {
    id: 'metadata',
    name: 'prepare_metadata_upload',
    label: 'Stage image and token metadata upload',
    args: (form) => ({
      imageName: form.imageName || null,
      metadataUri: form.metadataUri || null,
      website: form.website,
      xHandle: form.xHandle,
    }),
    run: (form) => ({
      metadata: {
        name: form.tokenName,
        symbol: form.tokenSymbol,
        description: form.description,
        image: form.imageName ? `pending-upload://${form.imageName}` : null,
        uri: form.metadataUri || 'pending-metadata-upload',
        extensions: {
          website: form.website,
          twitter: form.xHandle,
        },
      },
      next: 'Backend should pin image + metadata to IPFS/Arweave before execution.',
    }),
  },
  {
    id: 'config',
    name: 'build_meteora_dbc_config',
    label: 'Build Meteora DBC curve config',
    args: (form) => ({
      quoteAsset: form.quoteAsset,
      poolShape: form.poolShape,
      tokenDecimals: form.tokenDecimals,
      initialMarketCap: form.initialMarketCap,
      migrationMarketCap: form.migrationMarketCap,
      feeBps: form.feeBps,
    }),
    run: (form) => {
      const plan = buildLaunchPlan(form)
      return {
        token: {
          totalTokenSupply: form.totalSupply,
          leftover: plan.leftoverTokens,
          tokenAuthorityOption: 'Immutable',
        },
        poolShape: form.poolShape,
        migration: 'MET_DAMM_V2',
        liquidityDistribution: '100% partner permanently locked',
        quoteMint: plan.quoteMintLabel,
      }
    },
  },
  {
    id: 'simulate',
    name: 'simulate_launch_transaction',
    label: 'Simulate launch transaction before execute',
    args: (form) => ({
      command: buildCliPreview(form).split('\n')[1],
    }),
    run: (form) => {
      const plan = buildLaunchPlan(form)
      const errors = plan.validationIssues.filter((issue) => issue.severity === 'error')
      return {
        simulated: errors.length === 0,
        errors: errors.map((issue) => issue.message),
        note: errors.length === 0
          ? 'Ready for backend dry-run simulation with signer wallet.'
          : 'Fix blocking validation errors before simulation.',
      }
    },
  },
  {
    id: 'routing',
    name: 'stage_leftover_receiver_routing',
    label: 'Stage post-migration leftover routing',
    args: (form) => ({
      leftoverReceiver: form.leftoverReceiver || '<empty>',
      recipients: form.teamRecipients.length,
    }),
    run: (form) => ({
      afterMigration: [
        'withdrawLeftover(pool)',
        'fund developer rewards vault',
        'create team vesting transfers',
        'record treasury allocation',
      ],
      recipients: form.teamRecipients.map((recipient) => ({
        label: recipient.label,
        percentOfSupply: recipient.percentOfSupply,
        vestingMonths: recipient.vestingMonths,
      })),
    }),
  },
  {
    id: 'launch',
    name: 'ready_for_one_click_launch',
    label: 'Ready for wallet approval and launch',
    args: (form) => ({ payload: buildExecutionPayload(form) }),
    run: () => ({
      executeMainnet: false,
      reason: 'Launch token will request Phantom approval and submit through the backend when execution is enabled.',
    }),
  },
]

export async function* runDeveloperFunctions(form: LaunchForm): AsyncGenerator<DeveloperFunctionCall> {
  for (const developerFunction of developerFunctions) {
    const baseCall = {
      id: developerFunction.id,
      name: developerFunction.name,
      label: developerFunction.label,
      args: developerFunction.args(form),
    }

    yield { ...baseCall, status: 'running' }
    await delay(260)

    const result = developerFunction.run(form)
    const shouldBlock = developerFunction.id === 'receiver' && result.valid === false
    yield {
      ...baseCall,
      status: shouldBlock ? 'blocked' : 'complete',
      result,
    }

    if (shouldBlock) return
  }
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}
