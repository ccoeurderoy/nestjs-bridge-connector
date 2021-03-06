import {
  BanksUserAccount,
  ServiceAccount,
  Subscription,
  EventName,
  BanksUser,
  PostBanksUserAccountDTO,
  PostBanksUserTransactionDTO,
  BanksUserStatus,
  // BanksUserStatus,
  // PostBanksUserTransactionDTO,
  // PostBanksUserAccountDTO,
} from '@algoan/rest';
import { UnauthorizedException, Injectable, Logger } from '@nestjs/common';

import { AlgoanService } from '../../algoan/algoan.service';
import { AggregatorService } from '../../aggregator/services/aggregator.service';
import { AuthenticationResponse, BridgeAccount, BridgeTransaction } from '../../aggregator/interfaces/bridge.interface';
import { mapBridgeAccount, mapBridgeTransactions } from '../../aggregator/services/bridge/bridge.utils';
import { EventDTO } from '../dto/event.dto';
import { BankreaderLinkRequiredDTO } from '../dto/bandreader-link-required.dto';
import { BankreaderRequiredDTO } from '../dto/bankreader-required.dto';
import { ClientConfig } from '../../aggregator/services/bridge/bridge.client';

/**
 * Hook service
 */
@Injectable()
export class HooksService {
  /**
   * Class logger
   */
  private readonly logger: Logger = new Logger(HooksService.name);

  constructor(private readonly algoanService: AlgoanService, private readonly aggregator: AggregatorService) {}

  /**
   * Handle Algoan webhooks
   * @param event Event listened to
   * @param signature Signature headers, to check if the call is from Algoan
   */
  public async handleWebhook(event: EventDTO, signature: string): Promise<void> {
    const serviceAccount = this.algoanService.algoanClient.getServiceAccountBySubscriptionId(event.subscription.id);

    this.logger.debug(serviceAccount, `Found a service account for subscription "${event.subscription.id}"`);

    if (serviceAccount === undefined) {
      throw new UnauthorizedException(`No service account found for subscription ${event.subscription.id}`);
    }

    // From the Bridge connector, need to find the bridge equivalent
    const subscription: Subscription = serviceAccount.subscriptions.find(
      (sub: Subscription) => sub.id === event.subscription.id,
    );

    if (!subscription.validateSignature(signature, (event.payload as unknown) as { [key: string]: string })) {
      throw new UnauthorizedException('Invalid X-Hub-Signature: you cannot call this API');
    }

    switch (event.subscription.eventName) {
      case EventName.BANKREADER_LINK_REQUIRED:
        // @ts-ignore
        await this.handleBankreaderLinkRequiredEvent(serviceAccount, event.payload as BankreaderLinkRequiredDTO);
        break;

      // case EventName.BANKREADER_CONFIGURATION_REQUIRED:
      //   break;

      case EventName.BANKREADER_REQUIRED:
        await this.handleBankReaderRequiredEvent(serviceAccount, event.payload as BankreaderRequiredDTO);
        break;

      // The default case should never be reached, as the eventName is already checked in the DTO
      default:
        return;
    }

    return;
  }

  /**
   * Handle the "bankreader_link_required" event
   * Looks for a callback URL and generates a new redirect URL
   * @param serviceAccount Concerned Algoan service account attached to the subscription
   * @param payload Payload sent, containing the Banks User id
   */
  public async handleBankreaderLinkRequiredEvent(
    serviceAccount: ServiceAccount,
    payload: BankreaderLinkRequiredDTO,
  ): Promise<void> {
    /**
     * 1. GET the banks user to retrieve the callback URL
     */
    const banksUser: BanksUser = await serviceAccount.getBanksUserById(payload.banksUserId);
    this.logger.debug({ banksUser, serviceAccount }, `Found BanksUser with id ${banksUser.id}`);

    /**
     * 2. Generates a redirect URL
     */
    const redirectUrl: string = await this.aggregator.generateRedirectUrl(
      banksUser,
      serviceAccount.config as ClientConfig,
    );

    /**
     * 3. Update the Banks-User, sending to Algoan the generated URL
     */
    await banksUser.update({
      redirectUrl,
    });

    this.logger.debug(`Added redirect url ${banksUser.redirectUrl} to banksUser ${banksUser.id}`);

    return;
  }

  /**
   * Handle the "bankreader_required" subscription
   * It triggers the banks accounts and transactions synchronization
   * @param serviceAccount Concerned Algoan service account attached to the subscription
   * @param payload Payload sent, containing the Banks User id
   */
  public async handleBankReaderRequiredEvent(
    serviceAccount: ServiceAccount,
    payload: BankreaderRequiredDTO,
  ): Promise<void> {
    const banksUser: BanksUser = await serviceAccount.getBanksUserById(payload.banksUserId);

    /**
     * 0. Notify Algoan that the synchronization is starting
     */
    await banksUser.update({
      status: BanksUserStatus.SYNCHRONIZING,
    });

    /**
     * 1. Retrieves an access token from Bridge to access to the user accounts
     */
    const authenticationResponse: AuthenticationResponse = await this.aggregator.getAccessToken(
      banksUser,
      serviceAccount.config as ClientConfig,
    );
    const accessToken: string = authenticationResponse.access_token;
    const bridgeUserId: string = authenticationResponse.user.uuid;

    /**
     * 2. Retrieves Bridge banks accounts and send them to Algoan
     */
    const accounts: BridgeAccount[] = await this.aggregator.getAccounts(
      accessToken,
      serviceAccount.config as ClientConfig,
    );
    this.logger.debug({
      message: `Bridge accounts retrieved for Banks User "${banksUser.id}"`,
      accounts,
    });
    const algoanAccounts: PostBanksUserAccountDTO[] = await mapBridgeAccount(
      accounts,
      accessToken,
      this.aggregator,
      serviceAccount.config as ClientConfig,
    );
    const createdAccounts: BanksUserAccount[] = await banksUser.createAccounts(algoanAccounts);
    this.logger.debug({
      message: `Algoan accounts created for Banks User "${banksUser.id}"`,
      accounts: createdAccounts,
    });

    /**
     * 3. Notify Algoan that the accounts have been synchronized
     */
    await banksUser.update({
      status: BanksUserStatus.ACCOUNTS_SYNCHRONIZED,
    });

    /**
     * 4. Retrieves Bridge transactions and send them to Algoan
     */
    const transactions: BridgeTransaction[] = await this.aggregator.getTransactions(
      accessToken,
      serviceAccount.config as ClientConfig,
    );

    for (const account of createdAccounts) {
      const algoanTransactions: PostBanksUserTransactionDTO[] = await mapBridgeTransactions(
        transactions.filter((transaction: BridgeTransaction) => transaction.account.id === Number(account.reference)),
        accessToken,
        this.aggregator,
        serviceAccount.config as ClientConfig,
      );
      await banksUser.createTransactions(account.id, algoanTransactions);
    }

    /**
     * 5. Notify Algoan that the process is finished
     */
    await banksUser.update({
      status: BanksUserStatus.FINISHED,
    });

    /**
     * 6. Delete the user from Bridge
     */
    await this.aggregator.deleteUser(
      {
        bridgeUserId,
        banksUser,
        accessToken,
      },
      serviceAccount.config as ClientConfig,
    );

    return;
  }
}
