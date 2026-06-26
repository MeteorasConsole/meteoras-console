import { ChangeEvent, useEffect, useState } from 'react'
import {
  LaunchForm,
  PoolShape,
  TeamRecipient,
  buildCliPreview,
  buildExecutionPayload,
  buildLaunchPlan,
  defaultLaunchForm,
  formatCurrency,
  formatNumber,
} from './lib/launchpad'
import { DeveloperFunctionCall, runDeveloperFunctions } from './lib/functions'
import {
  DryRunLaunchResponse,
  ExecuteLaunchResponse,
  createDryRunLaunch,
  executeLaunch,
  getLaunchApiMode,
  isLaunchApiConfigured,
} from './lib/launchApi'
import {
  FeeClaimDryRunResponse,
  FeeClaimExecuteResponse,
  FeeClaimForm,
  CreatorLaunchListItem,
  createCreatorFeeClaimDryRun,
  executeCreatorFeeClaim,
  listCreatorLaunches,
} from './lib/feeClaims'
import {
  PinataMetadataCredentials,
  PinataMetadataUploadResponse,
  uploadMetadataWithPinataAgent,
} from './lib/metadataAgent'
import {
  BundlerDryRunResponse,
  BundlerExecuteResponse,
  BundlerForm,
  createBundlerDryRun,
  executeBundler,
  fetchBundleKeys,
} from './lib/bundlerApi'
import {
  connectPhantom,
  disconnectPhantom,
  getPhantomProvider,
  isPhantomAvailable,
  phantomDownloadUrl,
  signBase64Transactions,
} from './lib/phantom'

type NumericField = keyof Pick<
  LaunchForm,
  | 'optionalSeedBuy'
  | 'totalSupply'
  | 'publicFloatPercent'
  | 'developerRewardsPercent'
  | 'treasuryPercent'
  | 'initialMarketCap'
  | 'migrationMarketCap'
  | 'feeBps'
>

type WalletStatus = 'idle' | 'connecting' | 'connected'
type SigningStatus = 'idle' | 'preparing' | 'signing' | 'signed' | 'submitting' | 'submitted' | 'blocked'
type FeeClaimStatus = 'idle' | 'preparing' | 'signing' | 'signed' | 'submitting' | 'submitted' | 'blocked'
type LaunchListStatus = 'idle' | 'loading' | 'ready' | 'blocked'
type MetadataAgentStatus = 'idle' | 'uploading' | 'complete' | 'blocked'
type BundlerStatus = 'idle' | 'preparing' | 'ready' | 'signing' | 'submitting' | 'submitted' | 'blocked'

const GITHUB_REPO_URL = 'https://github.com/MeteorasConsole/meteoras-console'

const defaultBundlerForm: BundlerForm = {
  poolAddress: '',
  walletCount: 5,
  targetSupplyPercent: 10,
  slippageBps: 500,
}

const poolShapeGuides: Record<PoolShape, { eyebrow: string; title: string; body: string; outcome: string }> = {
  linear: {
    eyebrow: 'Steady curve',
    title: 'Linear pool',
    body: 'Price moves in even steps as buys come in, making the launch easier to reason about for both the team and early users.',
    outcome: 'Use for fairer community launches, smoother entries, and less aggressive repricing.',
  },
  exponential: {
    eyebrow: 'Demand curve',
    title: 'Exponential pool',
    body: 'Price accelerates as demand increases, so early supply clears lower and later entries pay into stronger scarcity.',
    outcome: 'Use for momentum launches, faster price discovery, and stronger upside capture.',
  },
}

function App() {
  const [form, setForm] = useState<LaunchForm>(defaultLaunchForm)
  const [functionCalls, setFunctionCalls] = useState<DeveloperFunctionCall[]>([])
  const [isLaunchingToken, setIsLaunchingToken] = useState(false)
  const [showPayload, setShowPayload] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [walletStatus, setWalletStatus] = useState<WalletStatus>('idle')
  const [walletError, setWalletError] = useState('')
  const [phantomInstalled, setPhantomInstalled] = useState(false)
  const [latestDryRun, setLatestDryRun] = useState<DryRunLaunchResponse | null>(null)
  const [signedTransactions, setSignedTransactions] = useState<string[]>([])
  const [signingStatus, setSigningStatus] = useState<SigningStatus>('idle')
  const [executeResult, setExecuteResult] = useState<ExecuteLaunchResponse | null>(null)
  const [feeClaimForm, setFeeClaimForm] = useState<FeeClaimForm>({
    poolAddress: '',
    creatorWallet: '',
    receiverWallet: '',
  })
  const [feeClaimDryRun, setFeeClaimDryRun] = useState<FeeClaimDryRunResponse | null>(null)
  const [feeClaimSignedTransactions, setFeeClaimSignedTransactions] = useState<string[]>([])
  const [feeClaimResult, setFeeClaimResult] = useState<FeeClaimExecuteResponse | null>(null)
  const [feeClaimStatus, setFeeClaimStatus] = useState<FeeClaimStatus>('idle')
  const [feeClaimError, setFeeClaimError] = useState('')
  const [creatorLaunches, setCreatorLaunches] = useState<CreatorLaunchListItem[]>([])
  const [creatorLaunchesStatus, setCreatorLaunchesStatus] = useState<LaunchListStatus>('idle')
  const [creatorLaunchesError, setCreatorLaunchesError] = useState('')
  const [metadataAgentStatus, setMetadataAgentStatus] = useState<MetadataAgentStatus>('idle')
  const [metadataAgentError, setMetadataAgentError] = useState('')
  const [metadataAgentResult, setMetadataAgentResult] = useState<PinataMetadataUploadResponse | null>(null)
  const [pinataCredentials, setPinataCredentials] = useState<PinataMetadataCredentials>({
    jwt: '',
    gateway: '',
  })
  const [bundlerForm, setBundlerForm] = useState<BundlerForm>(defaultBundlerForm)
  const [bundlerDryRun, setBundlerDryRun] = useState<BundlerDryRunResponse | null>(null)
  const [bundlerStatus, setBundlerStatus] = useState<BundlerStatus>('idle')
  const [bundlerError, setBundlerError] = useState('')
  const [bundlerResult, setBundlerResult] = useState<BundlerExecuteResponse | null>(null)
  const [bundleKeysSaved, setBundleKeysSaved] = useState(false)

  const plan = buildLaunchPlan(form)
  const errors = plan.validationIssues.filter((issue) => issue.severity === 'error')
  const warnings = plan.validationIssues.filter((issue) => issue.severity === 'warning')
  const readyForDryRun = errors.length === 0
  const launchApiMode = getLaunchApiMode()
  const launchActionLabel = getLaunchActionLabel(isLaunchingToken, signingStatus, executeResult)
  const metadataAgentReady = isLaunchApiConfigured() && Boolean(form.imagePreview && form.imageName && form.tokenName.trim() && form.tokenSymbol.trim())

  useEffect(() => {
    setPhantomInstalled(isPhantomAvailable())
    const provider = getPhantomProvider()
    if (!provider) return undefined

    let cancelled = false
    const rememberTrustedWallet = (address: string) => {
      if (cancelled) return
      rememberWallet(address)
    }
    const handleDisconnect = () => {
      if (cancelled) return
      clearWalletSession()
    }
    const handleAccountChanged = (publicKey?: { toBase58: () => string }) => {
      if (cancelled) return
      if (publicKey) {
        rememberWallet(publicKey.toBase58())
      } else {
        clearWalletSession()
      }
    }

    connectPhantom({ onlyIfTrusted: true }).then(rememberTrustedWallet).catch(() => undefined)
    provider.on?.('disconnect', handleDisconnect)
    provider.on?.('accountChanged', handleAccountChanged)

    return () => {
      cancelled = true
      provider.off?.('disconnect', handleDisconnect)
      provider.off?.('accountChanged', handleAccountChanged)
    }
  }, [])

  useEffect(() => {
    if (!walletAddress || !isLaunchApiConfigured()) {
      setCreatorLaunches([])
      setCreatorLaunchesStatus('idle')
      setCreatorLaunchesError('')
      return
    }

    let cancelled = false
    setCreatorLaunchesStatus('loading')
    setCreatorLaunchesError('')

    listCreatorLaunches(walletAddress)
      .then((launches) => {
        if (cancelled) return
        setCreatorLaunches(launches)
        setCreatorLaunchesStatus('ready')
      })
      .catch((error) => {
        if (cancelled) return
        setCreatorLaunches([])
        setCreatorLaunchesStatus('blocked')
        setCreatorLaunchesError(error instanceof Error ? error.message : 'Unable to load launched pools.')
      })

    return () => {
      cancelled = true
    }
  }, [walletAddress])

  function rememberWallet(address: string) {
    setWalletAddress(address)
    setWalletStatus('connected')
    setWalletError('')
    setForm((current) => (current.leftoverReceiver ? current : { ...current, leftoverReceiver: address }))
    setFeeClaimForm((current) => ({
      ...current,
      creatorWallet: current.creatorWallet || address,
      receiverWallet: current.receiverWallet || address,
    }))
  }

  function clearWalletSession() {
    setWalletAddress('')
    setWalletStatus('idle')
    setLatestDryRun(null)
    setSignedTransactions([])
    setSigningStatus('idle')
    setExecuteResult(null)
    setFeeClaimDryRun(null)
    setFeeClaimSignedTransactions([])
    setFeeClaimResult(null)
    setFeeClaimStatus('idle')
    setFeeClaimError('')
    setCreatorLaunches([])
    setCreatorLaunchesStatus('idle')
    setCreatorLaunchesError('')
    setMetadataAgentStatus('idle')
    setMetadataAgentError('')
    setMetadataAgentResult(null)
  }

  async function connectWallet() {
    if (walletStatus === 'connecting') return

    setWalletStatus('connecting')
    setWalletError('')
    try {
      const address = await connectPhantom()
      rememberWallet(address)
    } catch (error) {
      setWalletStatus('idle')
      setWalletError(error instanceof Error ? error.message : 'Unable to connect Phantom.')
    }
  }

  async function disconnectWallet() {
    await disconnectPhantom()
    clearWalletSession()
  }

  function updateField<K extends keyof LaunchForm>(key: K, value: LaunchForm[K]) {
    if (key === 'metadataUri') {
      setMetadataAgentStatus('idle')
      setMetadataAgentError('')
    }
    setForm((current) => ({ ...current, [key]: value }))
  }

  function updateNumber(key: NumericField, value: string) {
    updateField(key, Number(value) as LaunchForm[NumericField])
  }

  function updateFeeClaimField<K extends keyof FeeClaimForm>(key: K, value: FeeClaimForm[K]) {
    setFeeClaimForm((current) => ({ ...current, [key]: value }))
  }

  function updatePinataCredential<K extends keyof PinataMetadataCredentials>(
    key: K,
    value: PinataMetadataCredentials[K],
  ) {
    setPinataCredentials((current) => ({ ...current, [key]: value }))
    setMetadataAgentStatus('idle')
    setMetadataAgentError('')
  }

  function updateRecipient(id: string, patch: Partial<TeamRecipient>) {
    setForm((current) => ({
      ...current,
      teamRecipients: current.teamRecipients.map((recipient) =>
        recipient.id === id ? { ...recipient, ...patch } : recipient,
      ),
    }))
  }

  function addRecipient() {
    const id = `recipient-${Date.now()}`
    setForm((current) => ({
      ...current,
      teamRecipients: [
        ...current.teamRecipients,
        {
          id,
          label: 'New teammate',
          wallet: '',
          percentOfSupply: 1,
          vestingMonths: 12,
        },
      ],
    }))
  }

  function removeRecipient(id: string) {
    setForm((current) => ({
      ...current,
      teamRecipients: current.teamRecipients.filter((recipient) => recipient.id !== id),
    }))
  }

  function handleImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.addEventListener('load', () => {
      setForm((current) => ({
        ...current,
        imageName: file.name,
        imagePreview: typeof reader.result === 'string' ? reader.result : '',
      }))
      setMetadataAgentStatus('idle')
      setMetadataAgentError('')
      setMetadataAgentResult(null)
    })
    reader.readAsDataURL(file)
  }

  async function runPinataMetadataAgent() {
    if (metadataAgentStatus === 'uploading') return

    setMetadataAgentStatus('uploading')
    setMetadataAgentError('')
    setMetadataAgentResult(null)
    upsertFunctionCall({
      id: 'pinata-metadata-agent',
      name: 'pinata_metadata_agent',
      label: 'Upload token art and metadata to Pinata',
      status: 'running',
      args: {
        endpoint: '/api/metadata/pinata',
        imageName: form.imageName || null,
        tokenSymbol: form.tokenSymbol || null,
      },
    })

    try {
      const result = await uploadMetadataWithPinataAgent(form, pinataCredentials, walletAddress)
      setForm((current) => ({
        ...current,
        metadataUri: result.metadataUri,
      }))
      setMetadataAgentResult(result)
      setMetadataAgentStatus('complete')
      upsertFunctionCall({
        id: 'pinata-metadata-agent',
        name: 'pinata_metadata_agent',
        label: 'Upload token art and metadata to Pinata',
        status: 'complete',
        args: {
          endpoint: '/api/metadata/pinata',
          imageName: form.imageName || null,
          tokenSymbol: form.tokenSymbol || null,
        },
        result: {
          metadataUri: result.metadataUri,
          imageUri: result.imageUri,
          imageCid: result.uploads.image.cid,
          metadataCid: result.uploads.metadata.cid,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Metadata agent failed.'
      setMetadataAgentStatus('blocked')
      setMetadataAgentError(message)
      upsertFunctionCall({
        id: 'pinata-metadata-agent',
        name: 'pinata_metadata_agent',
        label: 'Upload token art and metadata to Pinata',
        status: 'blocked',
        args: {
          endpoint: '/api/metadata/pinata',
          imageName: form.imageName || null,
          tokenSymbol: form.tokenSymbol || null,
        },
        result: {
          error: message,
        },
      })
    }
  }

  function upsertFunctionCall(call: DeveloperFunctionCall) {
    setFunctionCalls((current) => {
      const index = current.findIndex((existing) => existing.id === call.id)
      if (index === -1) return [...current, call]
      return current.map((existing) => (existing.id === call.id ? call : existing))
    })
  }

  async function launchToken() {
    if (isLaunchingToken) return
    setIsLaunchingToken(true)
    setShowPayload(false)
    setFunctionCalls([])
    setLatestDryRun(null)
    setSignedTransactions([])
    setSigningStatus(isLaunchApiConfigured() ? 'preparing' : 'idle')
    setExecuteResult(null)

    try {
      for await (const call of runDeveloperFunctions(form)) {
        upsertFunctionCall(call)
      }

      if (isLaunchApiConfigured()) {
        if (!readyForDryRun) {
          blockBackendLaunchValidation()
          return
        }

        const dryRun = await prepareLaunchWithBackend()
        if (!dryRun) return

        const signed = await approveLaunchInWallet(dryRun)
        if (!signed) return

        await submitApprovedLaunch(dryRun, signed)
      }
    } catch (error) {
      upsertFunctionCall({
        id: 'api-dry-run',
        name: 'prepare_meteora_launch',
        label: 'Prepare launch with Meteora backend',
        status: 'blocked',
        args: {
          endpoint: '/api/launches/dry-run',
          poolShape: form.poolShape,
          quoteAsset: form.quoteAsset,
          signerWallet: walletAddress || null,
        },
        result: {
          error: error instanceof Error ? error.message : 'Unknown launch API error.',
        },
      })
    } finally {
      setIsLaunchingToken(false)
    }
  }

  async function refreshCreatorLaunches(wallet = walletAddress) {
    if (!wallet || !isLaunchApiConfigured()) return

    setCreatorLaunchesStatus('loading')
    setCreatorLaunchesError('')
    try {
      const launches = await listCreatorLaunches(wallet)
      setCreatorLaunches(launches)
      setCreatorLaunchesStatus('ready')
    } catch (error) {
      setCreatorLaunches([])
      setCreatorLaunchesStatus('blocked')
      setCreatorLaunchesError(error instanceof Error ? error.message : 'Unable to load launched pools.')
    }
  }

  async function claimCreatorFees(poolAddressOverride?: string) {
    if (feeClaimStatus === 'preparing' || feeClaimStatus === 'signing' || feeClaimStatus === 'submitting') return

    const claimForm = {
      ...feeClaimForm,
      poolAddress: poolAddressOverride?.trim() || feeClaimForm.poolAddress,
    }

    if (poolAddressOverride) {
      setFeeClaimForm((current) => ({ ...current, poolAddress: poolAddressOverride }))
    }

    setFeeClaimStatus(isLaunchApiConfigured() ? 'preparing' : 'blocked')
    setFeeClaimDryRun(null)
    setFeeClaimSignedTransactions([])
    setFeeClaimResult(null)
    setFeeClaimError('')

    if (!isLaunchApiConfigured()) {
      setFeeClaimError('Set VITE_LAUNCH_API_BASE_URL to prepare creator fee claims through the backend.')
      return
    }

    try {
      const dryRun = await createCreatorFeeClaimDryRun(claimForm, walletAddress)
      setFeeClaimDryRun(dryRun)

      if (dryRun.status === 'blocked' || !dryRun.payloadHash || !dryRun.transactions?.length) {
        setFeeClaimStatus('blocked')
        setFeeClaimError(dryRun.error || 'Backend did not return a claim transaction.')
        return
      }

      setFeeClaimStatus('signing')
      const signed = await signBase64Transactions(dryRun.transactions.map((transaction) => transaction.base64))
      setFeeClaimSignedTransactions(signed)
      setFeeClaimStatus('signed')

      setFeeClaimStatus('submitting')
      const result = await executeCreatorFeeClaim(dryRun.claimId, walletAddress, dryRun.payloadHash, signed)
      setFeeClaimResult(result)
      setFeeClaimStatus(result.status === 'blocked' ? 'blocked' : 'submitted')
      setFeeClaimError(result.error || '')
    } catch (error) {
      setFeeClaimStatus('blocked')
      setFeeClaimError(error instanceof Error ? error.message : 'Creator fee claim failed.')
    }
  }

  function blockBackendLaunchValidation() {
    setSigningStatus('blocked')
    upsertFunctionCall({
      id: 'api-dry-run',
      name: 'prepare_meteora_launch',
      label: 'Prepare launch with Meteora backend',
      status: 'blocked',
      args: {
        endpoint: '/api/launches/dry-run',
        poolShape: form.poolShape,
        quoteAsset: form.quoteAsset,
        signerWallet: walletAddress || null,
      },
      result: {
        errors: errors.map((issue) => issue.message),
        reason: 'Fix the blocking settings before the backend prepares a launch.',
      },
    })
  }

  async function prepareLaunchWithBackend(): Promise<DryRunLaunchResponse | null> {
    const baseCall = {
      id: 'api-dry-run',
      name: 'prepare_meteora_launch',
      label: 'Prepare launch with Meteora backend',
      args: {
        endpoint: '/api/launches/dry-run',
        poolShape: form.poolShape,
        quoteAsset: form.quoteAsset,
        signerWallet: walletAddress || null,
      },
    }

    setSigningStatus('preparing')

    try {
      upsertFunctionCall({ ...baseCall, status: 'running' })
      const dryRun = await createDryRunLaunch(form, walletAddress)
      const transactions = dryRun.transactions ?? []
      const readyForWallet = dryRun.status === 'simulated' && dryRun.simulation.ok && transactions.length > 0
      const hasPayloadHash = Boolean(dryRun.payloadHash)

      setLatestDryRun(dryRun)
      upsertFunctionCall({
        ...baseCall,
        status: readyForWallet && hasPayloadHash ? 'complete' : 'blocked',
        result: {
          launchId: dryRun.launchId,
          payloadHash: dryRun.payloadHash ?? null,
          simulated: dryRun.simulation.ok,
          metadataUri: dryRun.metadata?.uri ?? null,
          launchSteps: transactions.map((transaction) => transaction.name),
          requiredSigners: dryRun.simulation.requiredSigners ?? [],
          warnings: dryRun.simulation.warnings ?? [],
          next: readyForWallet
            ? 'Phantom will ask the connected wallet to approve the launch.'
            : dryRun.error || 'Backend did not return executable launch steps.',
        },
      })

      if (!readyForWallet || !hasPayloadHash) {
        setSigningStatus('blocked')
        return null
      }

      return dryRun
    } catch (error) {
      setSigningStatus('blocked')
      upsertFunctionCall({
        ...baseCall,
        status: 'blocked',
        result: {
          error: error instanceof Error ? error.message : 'Unknown launch API error.',
        },
      })
      return null
    }
  }

  async function approveLaunchInWallet(dryRun: DryRunLaunchResponse): Promise<string[] | null> {
    if (!dryRun.transactions?.length) return null

    setSigningStatus('signing')
    const baseCall = {
      id: 'phantom-sign',
      name: 'approve_launch_in_phantom',
      label: 'Ask Phantom for launch approval',
      args: {
        launchId: dryRun.launchId,
        signerWallet: walletAddress,
        launchSteps: dryRun.transactions.map((transaction) => transaction.name),
      },
    }

    try {
      upsertFunctionCall({ ...baseCall, status: 'running' })
      const signed = await signBase64Transactions(dryRun.transactions.map((transaction) => transaction.base64))
      setSignedTransactions(signed)
      setSigningStatus('signed')
      upsertFunctionCall({
        ...baseCall,
        status: 'complete',
        result: {
          approvedLaunchSteps: signed.length,
          signerWallet: walletAddress,
        },
      })
      return signed
    } catch (error) {
      setSigningStatus('blocked')
      upsertFunctionCall({
        ...baseCall,
        status: 'blocked',
        result: {
          error: error instanceof Error ? error.message : 'Wallet approval failed.',
        },
      })
      return null
    }
  }

  async function submitApprovedLaunch(dryRun: DryRunLaunchResponse, approvedTransactions: string[]) {
    if (!dryRun.payloadHash || approvedTransactions.length === 0) return

    setSigningStatus('submitting')
    const baseCall = {
      id: 'api-execute',
      name: 'launch_token',
      label: 'Launch token through Meteora backend',
      args: {
        endpoint: `/api/launches/${dryRun.launchId}/execute`,
        launchId: dryRun.launchId,
        signerWallet: walletAddress,
        approvedPayloadHash: dryRun.payloadHash,
        approvedLaunchSteps: approvedTransactions.length,
      },
    }

    try {
      upsertFunctionCall({ ...baseCall, status: 'running' })
      const result = await executeLaunch(
        dryRun.launchId,
        walletAddress,
        dryRun.payloadHash,
        approvedTransactions,
      )
      setExecuteResult(result)
      setSigningStatus(result.status === 'blocked' ? 'blocked' : 'submitted')
      if (result.status !== 'blocked') {
        void refreshCreatorLaunches(walletAddress)
      }
      upsertFunctionCall({
        ...baseCall,
        status: result.status === 'blocked' ? 'blocked' : 'complete',
        result: {
          status: result.status,
          signatures: result.signatures ?? (result.signature ? [result.signature] : []),
          error: result.error ?? null,
        },
      })
    } catch (error) {
      setSigningStatus('blocked')
      upsertFunctionCall({
        ...baseCall,
        status: 'blocked',
        result: {
          error: error instanceof Error ? error.message : 'Launch submission failed.',
        },
      })
    }
  }

  function updateBundlerField<K extends keyof BundlerForm>(key: K, value: BundlerForm[K]) {
    setBundlerForm((current) => ({ ...current, [key]: value }))
  }

  async function prepareBundle(poolOverride?: string): Promise<BundlerDryRunResponse | null> {
    if (bundlerStatus === 'preparing' || bundlerStatus === 'signing' || bundlerStatus === 'submitting') return null

    const form = {
      ...bundlerForm,
      poolAddress: poolOverride?.trim() || bundlerForm.poolAddress,
    }
    if (poolOverride) {
      setBundlerForm((current) => ({ ...current, poolAddress: poolOverride }))
    }

    setBundlerDryRun(null)
    setBundlerResult(null)
    setBundlerError('')
    setBundleKeysSaved(false)

    if (!isLaunchApiConfigured()) {
      setBundlerStatus('blocked')
      setBundlerError('Set VITE_LAUNCH_API_BASE_URL to prepare a bundle through the backend.')
      return null
    }
    if (!form.poolAddress.trim()) {
      setBundlerStatus('blocked')
      setBundlerError('Enter the DBC pool address of the launched token to bundle-buy.')
      return null
    }

    setBundlerStatus('preparing')
    const baseCall = {
      id: 'bundler-dry-run',
      name: 'prepare_bundle_buy',
      label: 'Generate wallets and size the bundle buy',
      args: {
        endpoint: '/api/bundler/dry-run',
        pool: form.poolAddress,
        walletCount: form.walletCount,
        targetSupplyPercent: form.targetSupplyPercent,
      },
    }

    try {
      upsertFunctionCall({ ...baseCall, status: 'running' })
      const dryRun = await createBundlerDryRun(form, walletAddress)
      setBundlerDryRun(dryRun)

      if (dryRun.status === 'blocked' || !dryRun.payloadHash || !dryRun.fundingTransactions?.length) {
        setBundlerStatus('blocked')
        setBundlerError(dryRun.error || 'Backend did not return bundle funding transactions.')
        upsertFunctionCall({ ...baseCall, status: 'blocked', result: { error: dryRun.error ?? 'Bundle preparation blocked.' } })
        return null
      }

      setBundlerStatus('ready')
      upsertFunctionCall({
        ...baseCall,
        status: 'complete',
        result: {
          bundleId: dryRun.bundleId,
          wallets: dryRun.walletPublicKeys?.length ?? 0,
          totalFundingSol: dryRun.estimate?.totalFundingSol ?? null,
          percentOfSupply: dryRun.estimate?.percentOfSupply ?? null,
          next: 'Download the wallet keys, then fund and fire the bundle buys.',
        },
      })
      return dryRun
    } catch (error) {
      setBundlerStatus('blocked')
      setBundlerError(error instanceof Error ? error.message : 'Bundle preparation failed.')
      upsertFunctionCall({
        ...baseCall,
        status: 'blocked',
        result: { error: error instanceof Error ? error.message : 'Bundle preparation failed.' },
      })
      return null
    }
  }

  async function downloadBundleKeys() {
    const bundleId = bundlerDryRun?.bundleId
    if (!bundleId) return

    try {
      const keys = await fetchBundleKeys(bundleId)
      downloadJsonFile(`bundle-${bundleId.slice(0, 8)}-keys.json`, keys)
      setBundleKeysSaved(true)
    } catch (error) {
      setBundlerError(error instanceof Error ? error.message : 'Could not export bundle wallet keys.')
    }
  }

  async function fundAndBuyBundle() {
    const dryRun = bundlerDryRun
    if (!dryRun?.payloadHash || !dryRun.fundingTransactions?.length) return
    if (bundlerStatus === 'signing' || bundlerStatus === 'submitting') return

    const baseCall = {
      id: 'bundler-execute',
      name: 'fund_and_buy_bundle',
      label: 'Fund bundle wallets and fire buys',
      args: {
        endpoint: `/api/bundler/${dryRun.bundleId}/execute`,
        bundleId: dryRun.bundleId,
        fundingTransactions: dryRun.fundingTransactions.length,
      },
    }

    setBundlerStatus('signing')
    setBundlerError('')
    try {
      upsertFunctionCall({ ...baseCall, status: 'running' })
      const signed = await signBase64Transactions(dryRun.fundingTransactions.map((transaction) => transaction.base64))

      setBundlerStatus('submitting')
      const result = await executeBundler(dryRun.bundleId, walletAddress, dryRun.payloadHash, signed)
      setBundlerResult(result)
      setBundlerStatus(result.status === 'blocked' ? 'blocked' : 'submitted')
      if (result.status === 'blocked' && result.error) setBundlerError(result.error)
      upsertFunctionCall({
        ...baseCall,
        status: result.status === 'blocked' ? 'blocked' : 'complete',
        result: {
          status: result.status,
          confirmed: result.summary?.confirmed ?? null,
          failed: result.summary?.failed ?? null,
          fundingSignatures: result.fundingSignatures ?? [],
          error: result.error ?? null,
        },
      })
    } catch (error) {
      setBundlerStatus('blocked')
      setBundlerError(error instanceof Error ? error.message : 'Bundle execution failed.')
      upsertFunctionCall({
        ...baseCall,
        status: 'blocked',
        result: { error: error instanceof Error ? error.message : 'Bundle execution failed.' },
      })
    }
  }

  if (!walletAddress) {
    return (
      <LandingPage
        phantomInstalled={phantomInstalled}
        walletError={walletError}
        walletStatus={walletStatus}
        onConnect={connectWallet}
      />
    )
  }

  return (
    <main className="studio">
      <header className="topbar">
        <div className="logo-lockup">
          <LogoMark />
          <div>
            <p className="kicker">Meteora DBC Console</p>
            <strong>Meteora&apos;s Console</strong>
          </div>
        </div>
        <div className="status-strip">
          <StatusPill tone={readyForDryRun ? 'good' : 'neutral'} label={readyForDryRun ? 'Ready' : 'Draft'} />
          <span>{launchApiMode === 'api' ? 'API dry-run' : 'Local dry-run'}</span>
          <span className="wallet-pill">{shortAddress(walletAddress)}</span>
        </div>
        <div className="top-actions">
          <button className="button button--ghost" onClick={disconnectWallet}>
            Disconnect
          </button>
          <button className="button button--ghost" onClick={() => setShowPayload((value) => !value)}>
            {showPayload ? 'Hide payload' : 'Payload'}
          </button>
          <button className="button button--primary top-launch-action" onClick={launchToken} disabled={isLaunchingToken}>
            {launchActionLabel}
          </button>
        </div>
      </header>

      <section className="intro-card">
        <div className="intro-copy">
          <p className="kicker">Launch Studio</p>
          <h1>Design the curve, reserve, and team routing in one pass.</h1>
          <p>
            A power console for token teams: choose the pool shape, validate the leftover receiver,
            stage metadata, simulate launch, and prepare post-migration routing from one UI.
          </p>
        </div>
        <div className="token-pass">
          <label className="token-art">
            <input type="file" accept="image/*" onChange={handleImage} />
            {form.imagePreview ? (
              <img src={form.imagePreview} alt="" />
            ) : (
              <span className="token-art__empty">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
                Upload image
              </span>
            )}
          </label>
        </div>
      </section>

      <section className="summary-grid">
        <Metric label="Public float" value={`${formatNumber(plan.publicFloatTokens)} tokens`} />
        <Metric label="Leftover reserve" value={`${formatNumber(plan.leftoverTokens)} tokens`} />
        <Metric label="Initial price" value={formatCurrency(plan.initialPrice)} />
        <Metric label="First buy estimate" value={`${formatNumber(plan.optionalSeedBuyTokensAtInitialPrice)} tokens`} />
        <Metric label="Pool shape" value={poolShapeGuides[form.poolShape].title} />
      </section>

      <CreatorFeePanel
        apiConfigured={isLaunchApiConfigured()}
        claimForm={feeClaimForm}
        dryRun={feeClaimDryRun}
        error={feeClaimError}
        executeResult={feeClaimResult}
        isBusy={feeClaimStatus === 'preparing' || feeClaimStatus === 'signing' || feeClaimStatus === 'submitting'}
        signedTransactions={feeClaimSignedTransactions}
        status={feeClaimStatus}
        walletAddress={walletAddress}
        launches={creatorLaunches}
        launchListStatus={creatorLaunchesStatus}
        launchListError={creatorLaunchesError}
        onChange={updateFeeClaimField}
        onClaim={claimCreatorFees}
        onClaimLaunch={(pool) => claimCreatorFees(pool)}
      />

      <BundlerPanel
        apiConfigured={isLaunchApiConfigured()}
        form={bundlerForm}
        dryRun={bundlerDryRun}
        error={bundlerError}
        executeResult={bundlerResult}
        status={bundlerStatus}
        keysSaved={bundleKeysSaved}
        walletAddress={walletAddress}
        launches={creatorLaunches}
        onChange={updateBundlerField}
        onPrepare={() => prepareBundle()}
        onPrepareForPool={(pool) => prepareBundle(pool)}
        onDownloadKeys={downloadBundleKeys}
        onFundAndBuy={fundAndBuyBundle}
      />

      <section className="main-grid">
        <article className="panel panel--wide">
          <PanelHeading index="01" title="Token Brief" subtitle="Metadata and public profile" />
          <div className="field-grid two">
            <label>
              Token name
              <input value={form.tokenName} onChange={(event) => updateField('tokenName', event.target.value)} />
            </label>
            <label>
              Symbol
              <input
                value={form.tokenSymbol}
                onChange={(event) => updateField('tokenSymbol', event.target.value.toUpperCase())}
              />
            </label>
          </div>
          <label>
            Description
            <textarea value={form.description} onChange={(event) => updateField('description', event.target.value)} />
          </label>
          <div className="field-grid two">
            <label>
              Website
              <input value={form.website} onChange={(event) => updateField('website', event.target.value)} />
            </label>
            <label>
              X handle
              <input value={form.xHandle} onChange={(event) => updateField('xHandle', event.target.value)} />
            </label>
          </div>
          <label>
            Metadata URI
            <input
              value={form.metadataUri}
              placeholder="https://.../metadata.json"
              onChange={(event) => updateField('metadataUri', event.target.value)}
            />
          </label>
          <div className="metadata-helper">
            <div className="metadata-helper__copy">
              <span>Pinata metadata agent</span>
              <p>
                This is the public URL to the token metadata JSON. Wallets, explorers, and the
                Meteora launch read it to show the token name, ticker, image, and description.
                Run the agent to upload token art and JSON to Pinata/IPFS, or paste an existing
                public metadata URL.
              </p>
            </div>
            <div className="metadata-key-grid">
              <label>
                Pinata JWT
                <input
                  type="password"
                  value={pinataCredentials.jwt}
                  placeholder="Paste one-time Pinata JWT"
                  autoComplete="off"
                  onChange={(event) => updatePinataCredential('jwt', event.target.value)}
                />
              </label>
              <label>
                Gateway domain
                <input
                  value={pinataCredentials.gateway}
                  placeholder="your-gateway.mypinata.cloud"
                  autoComplete="off"
                  onChange={(event) => updatePinataCredential('gateway', event.target.value)}
                />
              </label>
              <p>
                Use these fields for one-time uploads. They are sent to this app&apos;s backend for
                the upload and are not saved by the app. Rotate the JWT after launch if you want;
                keep it here while the tab is open for repeated uploads, or set server env for
                continuous runs.
              </p>
              <div className="metadata-key-links">
                <a href="https://app.pinata.cloud/developers/api-keys" target="_blank" rel="noreferrer">
                  Create Pinata JWT
                </a>
                <a href="https://app.pinata.cloud/gateways" target="_blank" rel="noreferrer">
                  Find gateway domain
                </a>
              </div>
            </div>
            <div className="metadata-agent">
              <div>
                <strong>{getMetadataAgentLabel(metadataAgentStatus)}</strong>
                <p>{getMetadataAgentCopy(metadataAgentStatus, metadataAgentError, metadataAgentResult)}</p>
              </div>
              <button
                className="button button--primary"
                onClick={runPinataMetadataAgent}
                disabled={!metadataAgentReady || metadataAgentStatus === 'uploading'}
              >
                {metadataAgentStatus === 'uploading' ? 'Uploading' : 'Run Pinata agent'}
              </button>
            </div>
            <div className="metadata-helper__steps">
              <strong>Pinata setup</strong>
              <ol>
                <li>Create a Pinata API key/JWT in API Keys.</li>
                <li>Copy your <code>mypinata.cloud</code> gateway domain from Gateways.</li>
                <li>Select token art, then run the agent to fill this field.</li>
              </ol>
              <p>For team/public use, prefer a scoped upload key instead of an admin JWT.</p>
            </div>
            <pre className="metadata-helper__code"><code>{`{
  "name": "Meteor Console",
  "symbol": "METEO",
  "description": "One-line token description.",
  "image": "https://your-gateway.mypinata.cloud/ipfs/<image-cid>"
}`}</code></pre>
          </div>
        </article>

        <article className="panel reserve-panel">
          <PanelHeading index="02" title="Reserve" subtitle="leftover_receiver control" />
          <label>
            Receiver wallet or multisig
            <input
              value={form.leftoverReceiver}
              placeholder="Solana public key"
              onChange={(event) => updateField('leftoverReceiver', event.target.value)}
            />
          </label>
          <AllocationMeter
            publicFloat={form.publicFloatPercent}
            rewards={form.developerRewardsPercent}
            treasury={form.treasuryPercent}
            team={plan.teamPercent}
          />
          <div className="mini-ledger">
            <Metric label="Rewards" value={`${formatNumber(plan.developerRewardsTokens)} tokens`} />
            <Metric label="Team" value={`${formatNumber(plan.teamTokens)} tokens`} />
            <Metric label="Treasury" value={`${formatNumber(plan.treasuryTokens)} tokens`} />
          </div>
        </article>

        <article className="panel panel--wide">
          <PanelHeading index="03" title="Curve Settings" subtitle="Meteora DBC economics" />
          <div className="pool-toolbar">
            <div className="toolbar-copy">
              <span>Pool shape</span>
              <strong>Choose the launch behavior you want.</strong>
              <p>Linear favors predictability. Exponential favors scarcity and faster repricing.</p>
            </div>
            <div className="pool-shape-grid">
              {(Object.keys(poolShapeGuides) as PoolShape[]).map((shape) => (
                <PoolShapeCard
                  key={shape}
                  shape={shape}
                  active={form.poolShape === shape}
                  onSelect={() => updateField('poolShape', shape)}
                />
              ))}
            </div>
          </div>
          <div className="info-toolbar">
            <strong>{poolShapeGuides[form.poolShape].title} result</strong>
            <span>{poolShapeGuides[form.poolShape].outcome}</span>
          </div>
          <div className="field-grid three">
            <label>
              Quote asset
              <select
                value={form.quoteAsset}
                onChange={(event) => updateField('quoteAsset', event.target.value as LaunchForm['quoteAsset'])}
              >
                <option value="SOL">SOL</option>
                <option value="USDC">USDC</option>
              </select>
            </label>
            <label>
              First buy (planned)
              <input
                type="number"
                min="0"
                step="0.1"
                value={form.optionalSeedBuy}
                onChange={(event) => updateNumber('optionalSeedBuy', event.target.value)}
              />
            </label>
            <label>
              Total supply
              <input
                type="number"
                min="1"
                value={form.totalSupply}
                onChange={(event) => updateNumber('totalSupply', event.target.value)}
              />
            </label>
            <label>
              Token decimals
              <select
                value={form.tokenDecimals}
                onChange={(event) =>
                  updateField('tokenDecimals', Number(event.target.value) as LaunchForm['tokenDecimals'])
                }
              >
                <option value="6">6</option>
                <option value="7">7</option>
                <option value="8">8</option>
                <option value="9">9</option>
              </select>
            </label>
            <label>
              Public float %
              <input
                type="number"
                min="1"
                max="99"
                value={form.publicFloatPercent}
                onChange={(event) => updateNumber('publicFloatPercent', event.target.value)}
              />
            </label>
            <label>
              Initial mcap
              <input
                type="number"
                min="1"
                value={form.initialMarketCap}
                onChange={(event) => updateNumber('initialMarketCap', event.target.value)}
              />
            </label>
            <label>
              Migration mcap
              <input
                type="number"
                min="1"
                value={form.migrationMarketCap}
                onChange={(event) => updateNumber('migrationMarketCap', event.target.value)}
              />
            </label>
            <label>
              Base fee bps
              <input
                type="number"
                min="25"
                value={form.feeBps}
                onChange={(event) => updateNumber('feeBps', event.target.value)}
              />
            </label>
            <label>
              Rewards %
              <input
                type="number"
                min="0"
                value={form.developerRewardsPercent}
                onChange={(event) => updateNumber('developerRewardsPercent', event.target.value)}
              />
            </label>
            <label>
              Treasury %
              <input
                type="number"
                min="0"
                value={form.treasuryPercent}
                onChange={(event) => updateNumber('treasuryPercent', event.target.value)}
              />
            </label>
          </div>
        </article>

        <article className="panel issues-panel">
          <PanelHeading index="04" title="Checks" subtitle="Fix before execute" />
          {errors.length === 0 && warnings.length === 0 ? (
            <p className="empty-state">All checks are clean.</p>
          ) : (
            <div className="issue-list">
              {errors.map((issue) => (
                <p className="issue issue--error" key={issue.field}>{issue.message}</p>
              ))}
              {warnings.map((issue) => (
                <p className="issue issue--warning" key={issue.field}>{issue.message}</p>
              ))}
            </div>
          )}
        </article>
      </section>

      <section className="bottom-grid">
        <article className="panel">
          <div className="panel-heading team-heading">
            <div>
              <span>05</span>
              <h2>Team Routing</h2>
              <p>Post-migration distribution queue.</p>
            </div>
            <button className="button button--ghost" onClick={addRecipient}>Add recipient</button>
          </div>
          <div className="recipient-list">
            {form.teamRecipients.map((recipient) => (
              <div className="recipient-row" key={recipient.id}>
                <input
                  value={recipient.label}
                  onChange={(event) => updateRecipient(recipient.id, { label: event.target.value })}
                  aria-label="Recipient label"
                />
                <input
                  value={recipient.wallet}
                  placeholder="wallet"
                  onChange={(event) => updateRecipient(recipient.id, { wallet: event.target.value })}
                  aria-label="Recipient wallet"
                />
                <input
                  type="number"
                  min="0"
                  value={recipient.percentOfSupply}
                  onChange={(event) =>
                    updateRecipient(recipient.id, { percentOfSupply: Number(event.target.value) })
                  }
                  aria-label="Percent of supply"
                />
                <input
                  type="number"
                  min="0"
                  value={recipient.vestingMonths}
                  onChange={(event) =>
                    updateRecipient(recipient.id, { vestingMonths: Number(event.target.value) })
                  }
                  aria-label="Vesting months"
                />
                <button className="remove-button" onClick={() => removeRecipient(recipient.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </article>

        <article className="panel functions-panel">
          <PanelHeading index="06" title="Developer Functions" subtitle="Launch function log" />
          <div className="call-list">
            {functionCalls.length === 0 && (
              <p className="empty-state">Click Launch token to run the local developer functions.</p>
            )}
            {functionCalls.map((call) => (
              <article className={`call call--${call.status}`} key={call.id}>
                <div className="call__top">
                  <strong>{call.name}</strong>
                  <span>{call.status}</span>
                </div>
                <p>{call.label}</p>
                <details>
                  <summary>Args / result</summary>
                  <pre>{JSON.stringify({ args: call.args, result: call.result }, null, 2)}</pre>
                </details>
              </article>
            ))}
          </div>
        </article>
      </section>

      <SignerPanel
        apiConfigured={isLaunchApiConfigured()}
        dryRun={latestDryRun}
        executeResult={executeResult}
        signedTransactions={signedTransactions}
        signingStatus={signingStatus}
        walletAddress={walletAddress}
        isLaunchingToken={isLaunchingToken}
        launchActionLabel={launchActionLabel}
        onLaunch={launchToken}
      />

      {showPayload && (
        <section className="panel payload-panel">
          <PanelHeading index="07" title="Execution Payload" subtitle="Backend boundary preview" />
          <div className="payload-grid">
            <pre>{JSON.stringify(buildExecutionPayload(form), null, 2)}</pre>
            <pre>{buildCliPreview(form)}</pre>
          </div>
        </section>
      )}
    </main>
  )
}

function LandingPage({
  phantomInstalled,
  walletError,
  walletStatus,
  onConnect,
}: {
  phantomInstalled: boolean
  walletError: string
  walletStatus: WalletStatus
  onConnect: () => void
}) {
  return (
    <main className="landing">
      <nav className="landing-nav">
        <div className="logo-lockup">
          <LogoMark />
          <div>
            <p className="kicker">Meteora DBC Console</p>
            <strong>Meteora&apos;s Console</strong>
          </div>
        </div>
        <div className="landing-links">
          <a href="#launch-flow">Launch flow</a>
          <a href="#pool-shapes">Pool shapes</a>
          <a href="#wallet-tools">Wallet tools</a>
          <a href="#leftover">Leftover receiver</a>
          <a href="#no-fees">No app fees</a>
        </div>
        <button className="button button--primary" onClick={onConnect} disabled={walletStatus === 'connecting'}>
          {walletStatus === 'connecting' ? 'Opening Phantom' : 'Sign in with Phantom'}
        </button>
      </nav>

      <section className="landing-hero">
        <div className="orbit-field" aria-hidden="true">
          <span className="orbit-ring orbit-ring--one" />
          <span className="orbit-ring orbit-ring--two" />
          <span className="orbit-ring orbit-ring--three" />
          <span className="orbit-line orbit-line--one" />
          <span className="orbit-line orbit-line--two" />
          <span className="orbit-line orbit-line--three" />
          <span className="orbit-node orbit-node--one" />
          <span className="orbit-node orbit-node--two" />
          <span className="orbit-node orbit-node--three" />
        </div>
        <div className="landing-copy">
          <p className="hero-pill">Built on Solana · Public launch tool</p>
          <h1>
            <span>Launch</span>
            <span>DBC Tokens</span>
            <em>
              <span>Without App</span>
              <span>Fees.</span>
            </em>
          </h1>
          <button className="contract-pill" onClick={onConnect} disabled={walletStatus === 'connecting'}>
            <span>{walletStatus === 'connecting' ? 'OPENING' : 'NO FEE'}</span>
            {walletStatus === 'connecting' ? 'Waiting for Phantom approval' : 'The app takes no launch fees'}
          </button>
          <div className="landing-actions">
            <button className="button button--primary landing-cta" onClick={onConnect} disabled={walletStatus === 'connecting'}>
              {walletStatus === 'connecting' ? 'Waiting for Phantom' : 'Sign in with Phantom'}
            </button>
            <a className="button button--ghost" href={phantomDownloadUrl} target="_blank" rel="noreferrer">
              {phantomInstalled ? 'Phantom detected' : 'Install Phantom'}
            </a>
            <a
              className="button button--ghost button--icon"
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="View Meteora's Console on GitHub"
            >
              <GitHubIcon />
              <span>GitHub</span>
            </a>
          </div>
          <p>
            A focused launch console for token art, DBC economics, wallet approval, creator fee claims,
            multi-wallet bundling, and <code>leftover_receiver</code> routing in one clean flow.
          </p>
          <p className="landing-disclaimer">Independent public tool. Not affiliated with Meteora.</p>
          <a className="landing-contact" href="mailto:support@meteorasconsole.xyz">
            Contact support@meteorasconsole.xyz
          </a>
          <p className="landing-mantra">ONE TOOL · ONE LAUNCH FLOW</p>
          {walletError && <p className="wallet-error">{walletError}</p>}
        </div>

        <div className="landing-stats" aria-label="Launch console metrics">
          <Metric label="App launch fee" value="$0" />
          <Metric label="Approval path" value="Phantom" />
          <Metric label="Creator fees" value="Claimable" />
          <Metric label="Network" value="Solana" />
        </div>
      </section>

      <section className="landing-grid" id="launch-flow">
        <article className="landing-card">
          <span>01</span>
          <h2>One launch frame</h2>
          <p>Set the token profile, supply, market caps, fees, quote asset, receiver wallet, and team routes before launch.</p>
        </article>
        <article className="landing-card" id="pool-shapes">
          <span>02</span>
          <h2>Linear or exponential</h2>
          <p>Choose a steadier linear curve for predictable entry or an exponential curve when the launch needs faster repricing under demand.</p>
        </article>
        <article className="landing-card landing-card--wallet" id="wallet-tools">
          <span>03</span>
          <h2>Wallet tools &amp; bundler</h2>
          <p>
            Generate fresh burner wallets, split SOL from your wallet into them, and bundle-buy your launched
            token across all of them at once for supply control. Download the keys so you always keep custody,
            and claim creator trading fees from every pool you launch.
          </p>
        </article>
        <article className="landing-card" id="leftover">
          <span>04</span>
          <h2>Leftover recovery</h2>
          <p>Make the <code>leftover_receiver</code> explicit up front, then prepare post-migration routing for rewards, treasury, and team allocations.</p>
        </article>
        <article className="landing-card" id="no-fees">
          <span>05</span>
          <h2>No app launch fees</h2>
          <p>This console is a public tool for easier launches. Teams still cover normal network and protocol costs, but the app does not add a launch fee.</p>
        </article>
      </section>
    </main>
  )
}

function LogoMark() {
  return (
    <img className="logo" src="/meteoras-console-logo.png" alt="" aria-hidden="true" />
  )
}

function GitHubIcon() {
  return (
    <svg className="button__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.36 6.84 9.72.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 7.03c.85 0 1.7.12 2.5.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.18 10.18 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"
      />
    </svg>
  )
}

function getLaunchActionLabel(
  isLaunchingToken: boolean,
  signingStatus: SigningStatus,
  executeResult: ExecuteLaunchResponse | null,
) {
  if (isLaunchingToken) {
    if (signingStatus === 'signing') return 'Approve in Phantom'
    if (signingStatus === 'submitting') return 'Launching token'
    return 'Preparing launch'
  }

  if (executeResult?.status === 'blocked') return 'Try launch again'
  return 'Launch token'
}

function getLaunchStatusCopy(
  signingStatus: SigningStatus,
  apiConfigured: boolean,
  dryRun: DryRunLaunchResponse | null,
  executeResult: ExecuteLaunchResponse | null,
) {
  if (!apiConfigured) {
    return {
      tone: 'idle',
      label: 'Local preview mode',
      shortStatus: 'Preview only',
      body: 'Launch token validates the setup locally. Configure the backend URL to enable a real Meteora launch.',
    }
  }

  if (executeResult?.status === 'blocked') {
    return {
      tone: 'bad',
      label: 'Launch paused by backend',
      shortStatus: 'Needs attention',
      body: executeResult.error || 'The backend refused to broadcast this launch. Check the launch settings or execution policy.',
    }
  }

  if (executeResult?.status === 'submitted' || executeResult?.status === 'confirmed' || signingStatus === 'submitted') {
    return {
      tone: 'good',
      label: 'Launch submitted',
      shortStatus: 'Submitted',
      body: 'The approved launch was sent through the backend. Check the returned signatures for confirmation.',
    }
  }

  if (signingStatus === 'blocked') {
    return {
      tone: 'bad',
      label: 'Launch needs attention',
      shortStatus: 'Blocked',
      body: 'Fix the highlighted validation or wallet issue, then run Launch token again.',
    }
  }

  if (signingStatus === 'submitting') {
    return {
      tone: 'active',
      label: 'Launching token',
      shortStatus: 'Submitting',
      body: 'Wallet approval is complete. The backend is submitting the launch now.',
    }
  }

  if (signingStatus === 'signed') {
    return {
      tone: 'good',
      label: 'Wallet approved',
      shortStatus: 'Approved',
      body: 'Phantom approved the launch. Submission starts automatically.',
    }
  }

  if (signingStatus === 'signing') {
    return {
      tone: 'active',
      label: 'Approve in Phantom',
      shortStatus: 'Wallet approval',
      body: 'Review the launch in Phantom. After approval, the app submits it automatically.',
    }
  }

  if (signingStatus === 'preparing') {
    return {
      tone: 'active',
      label: 'Preparing launch',
      shortStatus: 'Preparing',
      body: 'The backend is validating the settings and building the Meteora launch steps.',
    }
  }

  if (dryRun?.transactions?.length) {
    return {
      tone: 'good',
      label: 'Launch prepared',
      shortStatus: 'Prepared',
      body: 'The backend returned launch steps. Phantom approval happens inside the Launch token flow.',
    }
  }

  return {
    tone: 'idle',
    label: 'Ready when settings are complete',
    shortStatus: 'Ready',
    body: 'Use Launch token once after the token profile, pool shape, and receiver settings look right.',
  }
}

function formatLaunchStepName(name: string): string {
  const knownSteps: Record<string, string> = {
    createConfig: 'Create DBC config',
    createPool: 'Create token pool',
    withdrawLeftover: 'Withdraw leftover reserve',
  }

  if (knownSteps[name]) return knownSteps[name]

  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function SignerPanel({
  apiConfigured,
  dryRun,
  executeResult,
  signedTransactions,
  signingStatus,
  walletAddress,
  isLaunchingToken,
  launchActionLabel,
  onLaunch,
}: {
  apiConfigured: boolean
  dryRun: DryRunLaunchResponse | null
  executeResult: ExecuteLaunchResponse | null
  signedTransactions: string[]
  signingStatus: SigningStatus
  walletAddress: string
  isLaunchingToken: boolean
  launchActionLabel: string
  onLaunch: () => void
}) {
  const transactions = dryRun?.transactions ?? []
  const statusCopy = getLaunchStatusCopy(signingStatus, apiConfigured, dryRun, executeResult)

  return (
    <section className="panel signer-panel">
      <div className="panel-heading signer-heading">
        <span>00</span>
        <div>
          <h2>Launch Control</h2>
          <p>One button prepares the launch, asks Phantom for approval, then sends it through the backend.</p>
        </div>
      </div>

      <div className="signer-layout">
        <div className="signer-copy">
          <div className="launch-progress">
            <span className={`launch-progress__dot launch-progress__dot--${statusCopy.tone}`} />
            <div>
              <strong>{statusCopy.label}</strong>
              <p>{statusCopy.body}</p>
            </div>
          </div>
          <div className="signer-state">
            <span>Wallet</span>
            <strong>{shortAddress(walletAddress)}</strong>
          </div>
          <div className="signer-state">
            <span>Status</span>
            <strong>{statusCopy.shortStatus}</strong>
          </div>
          <div className="signer-state">
            <span>Launch ID</span>
            <strong>{dryRun ? shortHash(dryRun.launchId) : 'not prepared'}</strong>
          </div>
          <div className="signer-state">
            <span>Wallet approvals</span>
            <strong>{signedTransactions.length || 'pending'}</strong>
          </div>
        </div>

        <div className="transaction-review">
          {!apiConfigured && (
            <p className="notice-card">Local preview is on. Set <code>VITE_LAUNCH_API_BASE_URL</code> to launch through the Meteora backend.</p>
          )}
          {apiConfigured && transactions.length === 0 && (
            <p className="notice-card">Click <strong>Launch token</strong>. The app will validate settings, prepare the Meteora launch, open Phantom, and submit after approval.</p>
          )}
          {transactions.length > 0 && (
            <div className="transaction-list">
              {transactions.map((transaction) => (
                <article className="transaction-row" key={transaction.name}>
                  <div>
                    <strong>{formatLaunchStepName(transaction.name)}</strong>
                    <span>{transaction.requiredSigners.length} wallet approval step{transaction.requiredSigners.length === 1 ? '' : 's'}</span>
                  </div>
                  <small>{signedTransactions.length > 0 ? 'Approved' : 'Ready for Phantom'}</small>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="signer-actions">
        <button className="button button--primary" onClick={onLaunch} disabled={isLaunchingToken}>
          {launchActionLabel}
        </button>
      </div>

      {dryRun?.payloadHash && (
        <details className="advanced-transaction-details">
          <summary>Advanced launch details</summary>
          <p>Launch fingerprint: <code>{dryRun.payloadHash}</code></p>
          {transactions.map((transaction) => (
            <p key={transaction.name}>
              {transaction.name}: backend pre-approval{' '}
              {transaction.signedByServer?.length
                ? transaction.signedByServer.map((signer) => shortAddress(signer)).join(', ')
                : 'none'}
            </p>
          ))}
        </details>
      )}
      {executeResult && (
        <p className={`execute-result execute-result--${executeResult.status}`}>
          Launch status: {executeResult.status}
          {executeResult.error ? ` - ${executeResult.error}` : ''}
        </p>
      )}
    </section>
  )
}

function CreatorFeePanel({
  apiConfigured,
  claimForm,
  dryRun,
  error,
  executeResult,
  isBusy,
  launches,
  launchListError,
  launchListStatus,
  signedTransactions,
  status,
  walletAddress,
  onChange,
  onClaim,
  onClaimLaunch,
}: {
  apiConfigured: boolean
  claimForm: FeeClaimForm
  dryRun: FeeClaimDryRunResponse | null
  error: string
  executeResult: FeeClaimExecuteResponse | null
  isBusy: boolean
  launches: CreatorLaunchListItem[]
  launchListError: string
  launchListStatus: LaunchListStatus
  signedTransactions: string[]
  status: FeeClaimStatus
  walletAddress: string
  onChange: <K extends keyof FeeClaimForm>(key: K, value: FeeClaimForm[K]) => void
  onClaim: () => void
  onClaimLaunch: (poolAddress: string) => void
}) {
  const transactions = dryRun?.transactions ?? []
  const claimButtonLabel = getFeeClaimActionLabel(status, executeResult)
  const statusCopy = getFeeClaimStatusCopy(status, apiConfigured, dryRun, executeResult, error)

  return (
    <section className="panel creator-fee-panel">
      <div className="panel-heading signer-heading">
        <span>CF</span>
        <div>
          <h2>Creator Fees</h2>
          <p>Claim creator pool trading fees from every token this wallet launched.</p>
        </div>
      </div>

      <div className="launch-pool-list">
        <div className="launch-pool-list__heading">
          <div>
            <span>Your launched pools</span>
            <strong>Quick claim by token</strong>
          </div>
          <p>
            Every DBC token launched from this wallet appears here. Use one claim button to inspect fees,
            open Phantom, and submit the creator fee claim for that pool.
          </p>
        </div>

        {launchListStatus === 'loading' && (
          <p className="notice-card">Loading launched pools for {shortAddress(walletAddress)}.</p>
        )}
        {launchListStatus === 'blocked' && (
          <p className="notice-card">Could not load launched pools: {launchListError}</p>
        )}
        {launchListStatus !== 'loading' && launchListStatus !== 'blocked' && launches.length === 0 && (
          <p className="notice-card">
            Launch a token from this wallet and it will show up here for fast creator-fee claims. You can still paste any DBC pool address below.
          </p>
        )}
        {launches.length > 0 && (
          <div className="launch-pool-rows">
            {launches.map((launch) => (
              <article className="launch-pool-row" key={launch.launchId}>
                <div className="launch-pool-row__asset">
                  <strong>{launch.tokenSymbol}</strong>
                  <span>{launch.tokenName}</span>
                </div>
                <div className="launch-pool-row__meta">
                  <span>{launch.status === 'submitted' ? 'Launched pool' : 'Prepared pool'}</span>
                  <code>{shortAddress(launch.pool)}</code>
                  <small>{launch.quoteAsset} quote · {formatDateTime(launch.submittedAt ?? launch.createdAt)}</small>
                </div>
                <button
                  className="button button--ghost quick-claim-button"
                  onClick={() => onClaimLaunch(launch.pool)}
                  disabled={isBusy || !apiConfigured}
                >
                  Claim fees
                </button>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="fee-claim-layout">
        <div className="fee-claim-form">
          <p className="fee-claim-helper">
            Manual claim fallback: paste any DBC pool address, choose the creator signer and receiver, then run the same Phantom approval flow.
          </p>
          <div className="field-grid three">
            <label>
              Pool address
              <input
                value={claimForm.poolAddress}
                placeholder="DBC pool public key"
                onChange={(event) => onChange('poolAddress', event.target.value)}
              />
            </label>
            <label>
              Creator signer
              <input
                value={claimForm.creatorWallet}
                placeholder={walletAddress}
                onChange={(event) => onChange('creatorWallet', event.target.value)}
              />
            </label>
            <label>
              Fee receiver
              <input
                value={claimForm.receiverWallet}
                placeholder={claimForm.creatorWallet || walletAddress}
                onChange={(event) => onChange('receiverWallet', event.target.value)}
              />
            </label>
          </div>

          <div className="fee-claim-actions">
            <button className="button button--primary" onClick={() => onClaim()} disabled={isBusy}>
              {claimButtonLabel}
            </button>
            <span>{signedTransactions.length ? `${signedTransactions.length} wallet approval` : 'Phantom approval required'}</span>
          </div>
        </div>

        <div className="fee-claim-review">
          <div className="launch-progress">
            <span className={`launch-progress__dot launch-progress__dot--${statusCopy.tone}`} />
            <div>
              <strong>{statusCopy.label}</strong>
              <p>{statusCopy.body}</p>
            </div>
          </div>

          {dryRun?.fees && (
            <div className="fee-metric-grid">
              <Metric label="Base unclaimed" value={dryRun.fees.unclaimedBaseFee} />
              <Metric label="Quote unclaimed" value={dryRun.fees.unclaimedQuoteFee} />
              <Metric label="Base claimed" value={dryRun.fees.claimedBaseFee} />
              <Metric label="Quote claimed" value={dryRun.fees.claimedQuoteFee} />
            </div>
          )}

          {transactions.length > 0 && (
            <div className="transaction-list">
              {transactions.map((transaction) => (
                <article className="transaction-row" key={transaction.name}>
                  <div>
                    <strong>{formatLaunchStepName(transaction.name)}</strong>
                    <span>{transaction.requiredSigners.length} wallet approval step{transaction.requiredSigners.length === 1 ? '' : 's'}</span>
                  </div>
                  <small>{signedTransactions.length > 0 ? 'Approved' : 'Ready for Phantom'}</small>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      {dryRun?.payloadHash && (
        <details className="advanced-transaction-details">
          <summary>Advanced fee claim details</summary>
          <p>Claim fingerprint: <code>{dryRun.payloadHash}</code></p>
          <p>Pool: <code>{dryRun.pool}</code></p>
          <p>Receiver: <code>{dryRun.receiver}</code></p>
        </details>
      )}

      {executeResult && (
        <p className={`execute-result execute-result--${executeResult.status}`}>
          Fee claim status: {executeResult.status}
          {executeResult.error ? ` - ${executeResult.error}` : ''}
        </p>
      )}
    </section>
  )
}

function getFeeClaimActionLabel(status: FeeClaimStatus, executeResult: FeeClaimExecuteResponse | null) {
  if (status === 'preparing') return 'Preparing claim'
  if (status === 'signing') return 'Approve in Phantom'
  if (status === 'submitting') return 'Claiming fees'
  if (executeResult?.status === 'blocked') return 'Try claim again'
  return 'Claim creator fees'
}

function getFeeClaimStatusCopy(
  status: FeeClaimStatus,
  apiConfigured: boolean,
  dryRun: FeeClaimDryRunResponse | null,
  executeResult: FeeClaimExecuteResponse | null,
  error: string,
) {
  if (!apiConfigured) {
    return {
      tone: 'idle',
      label: 'Backend not connected',
      body: 'Set VITE_LAUNCH_API_BASE_URL to inspect pool fees and prepare a claim transaction.',
    }
  }

  if (executeResult?.status === 'blocked' || status === 'blocked') {
    return {
      tone: 'bad',
      label: 'Claim paused',
      body: error || executeResult?.error || dryRun?.error || 'The backend blocked this creator fee claim.',
    }
  }

  if (executeResult?.status === 'submitted' || executeResult?.status === 'confirmed' || status === 'submitted') {
    return {
      tone: 'good',
      label: 'Claim submitted',
      body: 'The signed creator fee claim was submitted through the backend.',
    }
  }

  if (status === 'submitting') {
    return {
      tone: 'active',
      label: 'Submitting claim',
      body: 'Wallet approval is complete. The backend is submitting the creator fee claim.',
    }
  }

  if (status === 'signing') {
    return {
      tone: 'active',
      label: 'Approve in Phantom',
      body: 'Review the creator fee claim transaction in Phantom.',
    }
  }

  if (status === 'preparing') {
    return {
      tone: 'active',
      label: 'Inspecting pool fees',
      body: 'The backend is reading the pool fee breakdown and preparing a claim transaction.',
    }
  }

  if (dryRun?.transactions?.length) {
    return {
      tone: 'good',
      label: 'Claim prepared',
      body: 'The backend returned a creator fee claim transaction ready for wallet approval.',
    }
  }

  return {
    tone: 'idle',
    label: 'Ready to inspect',
    body: 'Enter the DBC pool address. The connected creator wallet signs the claim.',
  }
}

function BundlerPanel({
  apiConfigured,
  form,
  dryRun,
  error,
  executeResult,
  status,
  keysSaved,
  walletAddress,
  launches,
  onChange,
  onPrepare,
  onPrepareForPool,
  onDownloadKeys,
  onFundAndBuy,
}: {
  apiConfigured: boolean
  form: BundlerForm
  dryRun: BundlerDryRunResponse | null
  error: string
  executeResult: BundlerExecuteResponse | null
  status: BundlerStatus
  keysSaved: boolean
  walletAddress: string
  launches: CreatorLaunchListItem[]
  onChange: <K extends keyof BundlerForm>(key: K, value: BundlerForm[K]) => void
  onPrepare: () => void
  onPrepareForPool: (poolAddress: string) => void
  onDownloadKeys: () => void
  onFundAndBuy: () => void
}) {
  const isBusy = status === 'preparing' || status === 'signing' || status === 'submitting'
  const estimate = dryRun?.estimate
  const prepared = status === 'ready' || status === 'signing' || status === 'submitting' || status === 'submitted'
  const statusCopy = getBundlerStatusCopy(status, apiConfigured, dryRun, executeResult, error)
  const prepareLabel = status === 'preparing'
    ? 'Generating…'
    : prepared
      ? 'Regenerate wallets'
      : 'Generate wallets'
  const fundLabel = status === 'signing'
    ? 'Approve in Phantom…'
    : status === 'submitting'
      ? 'Funding & buying…'
      : 'Fund wallets & buy'
  const fundingSol = estimate ? estimate.totalFundingSol.toFixed(3) : '—'

  return (
    <section className="panel bundler-panel">
      <div className="panel-heading signer-heading">
        <span>BX</span>
        <div>
          <h2>Launch Bundler</h2>
          <p>Generate fresh wallets, split SOL from your wallet into them, and bundle-buy your freshly launched token for supply control.</p>
        </div>
      </div>

      {launches.length > 0 && (
        <div className="bundler-pool-pills">
          <span>Bundle one of your launched pools:</span>
          {launches.map((launch) => (
            <button
              key={launch.launchId}
              type="button"
              className="bundler-pool-pill"
              onClick={() => onPrepareForPool(launch.pool)}
              disabled={isBusy || !apiConfigured}
            >
              {launch.tokenSymbol} · {shortAddress(launch.pool)}
            </button>
          ))}
        </div>
      )}

      <div className="bundler-layout">
        <div className="bundler-form">
          <p className="bundler-form__intro">
            Set the token you launched and how the buy should be spread, then walk the three steps on the way to a bundled buy.
          </p>
          <label>
            Token / DBC pool address
            <input
              value={form.poolAddress}
              placeholder="DBC pool public key of your launched token"
              onChange={(event) => onChange('poolAddress', event.target.value)}
            />
            <small className="field-hint">The pool address of the token you launched. Pick one of your pools above to fill this in automatically.</small>
          </label>
          <div className="field-grid three">
            <label>
              Wallets
              <input
                type="number"
                min={1}
                max={30}
                value={form.walletCount}
                onChange={(event) => onChange('walletCount', clampNumber(event.target.value, 1, 30, 5))}
              />
              <small className="field-hint">How many burner wallets to spread the buy across.</small>
            </label>
            <label>
              Target % of supply
              <input
                type="number"
                min={0.1}
                max={100}
                step={0.1}
                value={form.targetSupplyPercent}
                onChange={(event) => onChange('targetSupplyPercent', clampNumber(event.target.value, 0.1, 100, 10))}
              />
              <small className="field-hint">Roughly how much of the token supply all wallets should buy in total.</small>
            </label>
            <label>
              Slippage (bps)
              <input
                type="number"
                min={10}
                max={5000}
                value={form.slippageBps}
                onChange={(event) => onChange('slippageBps', clampNumber(event.target.value, 10, 5000, 500))}
              />
              <small className="field-hint">Price wiggle room per buy. 500 = 5%. Higher = more likely to fill.</small>
            </label>
          </div>

          <ol className="bundler-steps">
            <li className="bundler-step">
              <div className="bundler-step__head">
                <span className="bundler-step__num">1</span>
                <button className="button button--primary" onClick={onPrepare} disabled={isBusy || !apiConfigured}>
                  {prepareLabel}
                </button>
              </div>
              <p className="bundler-step__hint">
                Creates {form.walletCount} fresh burner wallet{form.walletCount === 1 ? '' : 's'} and quotes the curve to work out how
                much SOL each one needs to grab about {form.targetSupplyPercent}% of supply. Nothing moves on-chain yet —
                run it again any time to roll a brand-new set of wallets.
              </p>
            </li>

            <li className={`bundler-step ${prepared && !keysSaved ? 'bundler-step--attention' : ''}`}>
              <div className="bundler-step__head">
                <span className="bundler-step__num">2</span>
                <button className="button button--ghost" onClick={onDownloadKeys} disabled={!prepared || isBusy}>
                  {keysSaved ? 'Keys downloaded ✓' : 'Download wallet keys'}
                </button>
              </div>
              <p className="bundler-step__hint">
                Saves the burner wallets&apos; private keys to a file on your computer. <strong>Do this before funding</strong> —
                it is the only way to get the SOL and tokens back out of these wallets later.
              </p>
            </li>

            <li className="bundler-step">
              <div className="bundler-step__head">
                <span className="bundler-step__num">3</span>
                <button
                  className="button button--primary"
                  onClick={onFundAndBuy}
                  disabled={!prepared || isBusy || status === 'submitted' || !keysSaved}
                >
                  {fundLabel}
                </button>
              </div>
              <p className="bundler-step__hint">
                Phantom asks you to approve moving ~{fundingSol} SOL from your connected wallet into the burners, then every
                burner buys your token at once.{!keysSaved ? ' Download the keys in step 2 first to unlock this.' : ''}
              </p>
            </li>
          </ol>
        </div>

        <div className="bundler-review">
          <div className="launch-progress">
            <span className={`launch-progress__dot launch-progress__dot--${statusCopy.tone}`} />
            <div>
              <strong>{statusCopy.label}</strong>
              <p>{statusCopy.body}</p>
            </div>
          </div>

          {estimate && (
            <div className="fee-metric-grid">
              <Metric label="Wallets" value={`${estimate.walletCount}`} />
              <Metric label="Est. supply bought" value={`${estimate.percentOfSupply.toFixed(2)}%`} />
              <Metric label="Total funding" value={`${estimate.totalFundingSol.toFixed(4)} SOL`} />
              <Metric label="Per wallet" value={`${estimate.perWalletBuySol.toFixed(4)} SOL`} />
            </div>
          )}

          {dryRun?.walletPublicKeys && dryRun.walletPublicKeys.length > 0 && (
            <details className="advanced-transaction-details">
              <summary>{dryRun.walletPublicKeys.length} generated wallets {dryRun.keysEncrypted ? '(encrypted at rest)' : '(stored unencrypted)'}</summary>
              <div className="bundler-wallet-list">
                {dryRun.walletPublicKeys.map((pubkey) => (
                  <code key={pubkey}>{pubkey}</code>
                ))}
              </div>
            </details>
          )}

          {dryRun?.warnings?.map((warning) => (
            <p className="notice-card" key={warning}>{warning}</p>
          ))}

          {executeResult?.buyResults && executeResult.buyResults.length > 0 && (
            <div className="transaction-list">
              {executeResult.buyResults.map((result) => (
                <article className="transaction-row" key={result.wallet}>
                  <div>
                    <strong>{shortAddress(result.wallet)}</strong>
                    <span>{result.error ? `Failed: ${result.error}` : 'Buy confirmed'}</span>
                  </div>
                  <small>{result.error ? 'error' : 'ok'}</small>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      {executeResult && (
        <p className={`execute-result execute-result--${executeResult.status}`}>
          Bundle status: {executeResult.status}
          {executeResult.summary ? ` — ${executeResult.summary.confirmed}/${executeResult.summary.wallets} buys confirmed` : ''}
          {executeResult.error ? ` - ${executeResult.error}` : ''}
        </p>
      )}
    </section>
  )
}

function getBundlerStatusCopy(
  status: BundlerStatus,
  apiConfigured: boolean,
  dryRun: BundlerDryRunResponse | null,
  executeResult: BundlerExecuteResponse | null,
  error: string,
) {
  if (!apiConfigured) {
    return { tone: 'idle', label: 'Backend not connected', body: 'Set VITE_LAUNCH_API_BASE_URL to generate wallets and size a bundle buy.' }
  }
  if (status === 'blocked') {
    return { tone: 'bad', label: 'Bundle paused', body: error || executeResult?.error || dryRun?.error || 'The backend blocked this bundle.' }
  }
  if (status === 'submitted') {
    return { tone: 'good', label: 'Bundle submitted', body: 'Funding landed and the bundle buys were fired. Review per-wallet results below.' }
  }
  if (status === 'submitting') {
    return { tone: 'active', label: 'Funding & buying', body: 'Funding confirmed; bundle wallets are buying the token now.' }
  }
  if (status === 'signing') {
    return { tone: 'active', label: 'Approve in Phantom', body: 'Review the funding transactions in Phantom to move SOL into the bundle wallets.' }
  }
  if (status === 'preparing') {
    return { tone: 'active', label: 'Sizing the bundle', body: 'Generating wallets and quoting the curve for your supply target.' }
  }
  if (status === 'ready') {
    return { tone: 'good', label: 'Bundle prepared', body: 'Wallets generated and funding transactions ready. Download keys, then fund and buy.' }
  }
  return { tone: 'idle', label: 'Ready to bundle', body: 'Paste your launched pool address, set the wallet count and supply target, then prepare the bundle.' }
}

function clampNumber(raw: string, min: number, max: number, fallback: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function PoolShapeCard({
  shape,
  active,
  onSelect,
}: {
  shape: PoolShape
  active: boolean
  onSelect: () => void
}) {
  const guide = poolShapeGuides[shape]

  return (
    <button
      type="button"
      className={`shape-card ${active ? 'shape-card--active' : ''}`}
      onClick={onSelect}
      aria-pressed={active}
    >
      <span>{guide.eyebrow}</span>
      <strong>{guide.title}</strong>
      <p>{guide.body}</p>
      <small>{guide.outcome}</small>
    </button>
  )
}

function PanelHeading({ index, title, subtitle }: { index: string; title: string; subtitle: string }) {
  return (
    <div className="panel-heading">
      <span>{index}</span>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function StatusPill({ tone, label }: { tone: 'good' | 'bad' | 'neutral'; label: string }) {
  return <strong className={`status-pill status-pill--${tone}`}>{label}</strong>
}

function getMetadataAgentLabel(status: MetadataAgentStatus): string {
  if (status === 'uploading') return 'Uploading to Pinata'
  if (status === 'complete') return 'Metadata URI filled'
  if (status === 'blocked') return 'Agent needs attention'
  return 'Upload art + metadata'
}

function getMetadataAgentCopy(
  status: MetadataAgentStatus,
  error: string,
  result: PinataMetadataUploadResponse | null,
): string {
  if (status === 'uploading') return 'Uploading token art first, then pinning metadata JSON with that image URL.'
  if (status === 'complete') return result ? `Pinned metadata ${shortAddress(result.uploads.metadata.cid)} and image ${shortAddress(result.uploads.image.cid)}.` : 'Pinned metadata to Pinata.'
  if (status === 'blocked') return error || 'Check the pasted Pinata key, gateway, and selected token art.'
  return 'Paste a Pinata JWT for a one-time run or leave it blank if the backend has Pinata env. The app fills Metadata URI after upload.'
}

function shortAddress(address: string): string {
  if (!address) return 'not connected'
  return `${address.slice(0, 4)}...${address.slice(-4)}`
}

function shortHash(value: string): string {
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function AllocationMeter({
  publicFloat,
  rewards,
  treasury,
  team,
}: {
  publicFloat: number
  rewards: number
  treasury: number
  team: number
}) {
  return (
    <div className="allocation-meter">
      <div className="allocation-meter__bar">
        <span className="meter-segment meter-segment--float" style={{ width: `${clamp(publicFloat)}%` }} />
        <span className="meter-segment meter-segment--rewards" style={{ width: `${clamp(rewards)}%` }} />
        <span className="meter-segment meter-segment--treasury" style={{ width: `${clamp(treasury)}%` }} />
        <span className="meter-segment meter-segment--team" style={{ width: `${clamp(team)}%` }} />
      </div>
      <div className="allocation-meter__key">
        <span>Float {publicFloat}%</span>
        <span>Rewards {rewards}%</span>
        <span>Treasury {treasury}%</span>
        <span>Team {team}%</span>
      </div>
    </div>
  )
}

function clamp(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

export default App
