import { Transaction } from '@solana/web3.js'
import type { PublicKey } from '@solana/web3.js'

export type PhantomProvider = {
  isPhantom?: boolean
  isConnected?: boolean
  publicKey?: PublicKey
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>
  disconnect?: () => Promise<void>
  signTransaction?: (transaction: Transaction) => Promise<Transaction>
  signAllTransactions?: (transactions: Transaction[]) => Promise<Transaction[]>
  on?: (event: 'connect' | 'disconnect' | 'accountChanged', handler: (publicKey?: PublicKey) => void) => void
  off?: (event: 'connect' | 'disconnect' | 'accountChanged', handler: (publicKey?: PublicKey) => void) => void
}

declare global {
  interface Window {
    solana?: PhantomProvider
    phantom?: {
      solana?: PhantomProvider
    }
  }
}

export const phantomDownloadUrl = 'https://phantom.app/'

export function getPhantomProvider(): PhantomProvider | null {
  if (typeof window === 'undefined') return null

  const provider = window.phantom?.solana ?? window.solana
  return provider?.isPhantom ? provider : null
}

export function isPhantomAvailable(): boolean {
  return Boolean(getPhantomProvider())
}

export async function connectPhantom(options?: { onlyIfTrusted?: boolean }): Promise<string> {
  const provider = getPhantomProvider()
  if (!provider) {
    throw new Error('Phantom is not installed. Install Phantom or open this app in the Phantom browser.')
  }

  const response = await provider.connect(options)
  return response.publicKey.toBase58()
}

export async function disconnectPhantom() {
  const provider = getPhantomProvider()
  await provider?.disconnect?.()
}

export async function signBase64Transactions(transactionsBase64: string[]): Promise<string[]> {
  const provider = getPhantomProvider()
  if (!provider) {
    throw new Error('Phantom is not installed.')
  }

  const transactions = transactionsBase64.map((encoded) => Transaction.from(base64ToBytes(encoded)))
  const signedTransactions = provider.signAllTransactions
    ? await provider.signAllTransactions(transactions)
    : await signOneByOne(provider, transactions)

  return signedTransactions.map((transaction) =>
    bytesToBase64(
      transaction.serialize({
        requireAllSignatures: true,
        verifySignatures: false,
      }),
    ),
  )
}

async function signOneByOne(provider: PhantomProvider, transactions: Transaction[]) {
  if (!provider.signTransaction) {
    throw new Error('This Phantom provider does not expose transaction signing.')
  }

  const signedTransactions: Transaction[] = []
  for (const transaction of transactions) {
    signedTransactions.push(await provider.signTransaction(transaction))
  }

  return signedTransactions
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return window.btoa(binary)
}
