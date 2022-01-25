/*
 * Copyright 2021, Offchain Labs, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint-env node */
'use strict'

import { TransactionReceipt } from '@ethersproject/providers'
import { Log } from '@ethersproject/abstract-provider'
import { ContractTransaction } from '@ethersproject/contracts'
import { BigNumber } from '@ethersproject/bignumber'
import {
  L1ToL2Message,
  L1ToL2MessageReaderOrWriter,
  L1ToL2MessageReader,
  L1ToL2MessageWriter,
} from './L1ToL2Message'

import { L1ERC20Gateway__factory, Inbox__factory } from '../abi'
import { DepositInitiatedEvent } from '../abi/L1ERC20Gateway'
import {
  SignerProviderUtils,
  SignerOrProvider,
} from '../dataEntities/signerOrProvider'
import { ArbTsError } from '../dataEntities/errors'

export interface L1ContractTransaction extends ContractTransaction {
  wait(confirmations?: number): Promise<L1TransactionReceipt>
}

export class L1TransactionReceipt implements TransactionReceipt {
  public readonly to: string
  public readonly from: string
  public readonly contractAddress: string
  public readonly transactionIndex: number
  public readonly root?: string
  public readonly gasUsed: BigNumber
  public readonly logsBloom: string
  public readonly blockHash: string
  public readonly transactionHash: string
  public readonly logs: Array<Log>
  public readonly blockNumber: number
  public readonly confirmations: number
  public readonly cumulativeGasUsed: BigNumber
  public readonly effectiveGasPrice: BigNumber
  public readonly byzantium: boolean
  public readonly type: number
  public readonly status?: number

  constructor(tx: TransactionReceipt) {
    this.to = tx.to
    this.from = tx.from
    this.contractAddress = tx.contractAddress
    this.transactionIndex = tx.transactionIndex
    this.root = tx.root
    this.gasUsed = tx.gasUsed
    this.logsBloom = tx.logsBloom
    this.blockHash = tx.blockHash
    this.transactionHash = tx.transactionHash
    this.logs = tx.logs
    this.blockNumber = tx.blockNumber
    this.confirmations = tx.confirmations
    this.cumulativeGasUsed = tx.cumulativeGasUsed
    this.effectiveGasPrice = tx.effectiveGasPrice
    this.byzantium = tx.byzantium
    this.type = tx.type
    this.status = tx.status
  }

  /**
   * Get the numbers of any messages created by this transaction
   * @returns
   */
  public getMessageNumbers(): BigNumber[] {
    const iface = Inbox__factory.createInterface()
    const messageDelivered = iface.getEvent('InboxMessageDelivered')
    const messageDeliveredFromOrigin = iface.getEvent(
      'InboxMessageDeliveredFromOrigin'
    )
    const eventTopics = {
      InboxMessageDelivered: iface.getEventTopic(messageDelivered),
      InboxMessageDeliveredFromOrigin: iface.getEventTopic(
        messageDeliveredFromOrigin
      ),
    }
    const logs = this.logs.filter(
      log =>
        log.topics[0] === eventTopics.InboxMessageDelivered ||
        log.topics[0] === eventTopics.InboxMessageDeliveredFromOrigin
    )
    return logs.map(log => BigNumber.from(log.topics[1]))
  }

  /**
   * Get any l1tol2 messages created by this transaction
   * @param l2SignerOrProvider
   */
  public async getL1ToL2Messages<T extends SignerOrProvider>(
    l2SignerOrProvider: T
  ): Promise<L1ToL2MessageReaderOrWriter<T>[]>
  public async getL1ToL2Messages<T extends SignerOrProvider>(
    l2SignerOrProvider: T
  ): Promise<L1ToL2MessageReader[] | L1ToL2MessageWriter[]> {
    const provider = SignerProviderUtils.getProviderOrThrow(l2SignerOrProvider)

    const chainID = (await provider.getNetwork()).chainId.toString()

    const messageNumbers = this.getMessageNumbers()
    if (!messageNumbers || messageNumbers.length === 0) return []

    return messageNumbers.map((mn: BigNumber) => {
      const ticketCreationHash = L1ToL2Message.calculateRetryableCreationId(
        BigNumber.from(chainID),
        mn
      )
      return L1ToL2Message.fromRetryableCreationId(
        l2SignerOrProvider,
        ticketCreationHash,
        mn
      )
    })
  }

  /**
   * Gets a single l1ToL2Message
   * If the messageIndex is supplied the message at that index will be returned.
   * If no messageIndex is supplied a message will be returned if this transaction only created one message
   * All other cases throw an error
   * @param l2SignerOrProvider
   */
  public async getL1ToL2Message<T extends SignerOrProvider>(
    l2SignerOrProvider: T,
    messageNumberIndex?: number
  ): Promise<L1ToL2MessageReaderOrWriter<T>>
  public async getL1ToL2Message<T extends SignerOrProvider>(
    l2SignerOrProvider: T,
    messageIndex?: number
  ): Promise<L1ToL2MessageReader | L1ToL2MessageWriter> {
    const allL1ToL2Messages = await this.getL1ToL2Messages(l2SignerOrProvider)
    const messageCount = allL1ToL2Messages.length
    if (!messageCount)
      throw new ArbTsError(
        `No l1 to L2 message found for ${this.transactionHash}`
      )

    if (messageIndex !== undefined && messageIndex >= messageCount)
      throw new ArbTsError(
        `Provided message number out of range for ${this.transactionHash}; index was ${messageIndex}, but only ${messageCount} messages`
      )
    if (messageIndex === undefined && messageCount > 1)
      throw new ArbTsError(
        `${messageCount} L2 messages for ${this.transactionHash}; must provide messageNumberIndex (or use (signersAndProviders, l1Txn))`
      )

    return allL1ToL2Messages[messageIndex || 0]
  }

  /**
   * Get any deposit events created by this transaction
   * @returns
   */
  public getDepositEvents(): DepositInitiatedEvent['args'][] {
    const iface = L1ERC20Gateway__factory.createInterface()
    const event = iface.getEvent('DepositInitiated')
    const eventTopic = iface.getEventTopic(event)
    const logs = this.logs.filter(log => log.topics[0] === eventTopic)
    return logs.map(
      log => iface.parseLog(log).args as DepositInitiatedEvent['args']
    )
  }

  /**
   * Check if tx is a direct call to a depositEth function (i.e., on the Inbox contract)
   * @returns
   */
  public async looksLikeEthDeposit(
    l1SignerOrProvider: SignerOrProvider
  ): Promise<boolean> {
    const l1Provider =
      SignerProviderUtils.getProviderOrThrow(l1SignerOrProvider)
    const txRes = await l1Provider.getTransaction(this.transactionHash)
    // Function signature for depositEth
    const depositEth_FUNCTION_SIG = '0x0f4d14e9'
    return txRes.data.startsWith(depositEth_FUNCTION_SIG)
  }

  /**
   * Replaces the wait function with one that returns an L1TransactionReceipt
   * @param contractTransaction
   * @returns
   */
  public static monkeyPatchWait = (
    contractTransaction: ContractTransaction
  ): L1ContractTransaction => {
    const wait = contractTransaction.wait
    contractTransaction.wait = async (confirmations?: number) => {
      const result = await wait(confirmations)
      return new L1TransactionReceipt(result)
    }
    return contractTransaction as L1ContractTransaction
  }
}
