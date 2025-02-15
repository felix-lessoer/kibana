/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { SearchHit } from '@elastic/elasticsearch/lib/api/types';
import { internal, notFound } from '@hapi/boom';
import type { ActionsClient } from '@kbn/actions-plugin/server';
import type { ElasticsearchClient } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type { PublicMethodsOf } from '@kbn/utility-types';
import apm from 'elastic-apm-node';
import { decode, encode } from 'gpt-tokenizer';
import { last, merge, noop, omit, pick, take } from 'lodash';
import {
  filter,
  isObservable,
  last as lastOperator,
  lastValueFrom,
  Observable,
  shareReplay,
  toArray,
} from 'rxjs';
import { Readable } from 'stream';
import { v4 } from 'uuid';
import { ObservabilityAIAssistantConnectorType } from '../../../common/connectors';
import {
  ChatCompletionChunkEvent,
  ChatCompletionErrorEvent,
  createConversationNotFoundError,
  createTokenLimitReachedError,
  MessageAddEvent,
  StreamingChatResponseEventType,
  type StreamingChatResponseEvent,
} from '../../../common/conversation_complete';
import {
  FunctionResponse,
  FunctionVisibility,
  MessageRole,
  type CompatibleJSONSchema,
  type Conversation,
  type ConversationCreateRequest,
  type ConversationUpdateRequest,
  type KnowledgeBaseEntry,
  type Message,
} from '../../../common/types';
import { concatenateChatCompletionChunks } from '../../../common/utils/concatenate_chat_completion_chunks';
import { emitWithConcatenatedMessage } from '../../../common/utils/emit_with_concatenated_message';
import type { ChatFunctionClient } from '../chat_function_client';
import {
  KnowledgeBaseEntryOperationType,
  KnowledgeBaseService,
  RecalledEntry,
} from '../knowledge_base_service';
import type { ObservabilityAIAssistantResourceNames } from '../types';
import { getAccessQuery } from '../util/get_access_query';
import { createBedrockClaudeAdapter } from './adapters/bedrock_claude_adapter';
import { createOpenAiAdapter } from './adapters/openai_adapter';
import { LlmApiAdapter } from './adapters/types';

export class ObservabilityAIAssistantClient {
  constructor(
    private readonly dependencies: {
      actionsClient: PublicMethodsOf<ActionsClient>;
      namespace: string;
      esClient: {
        asInternalUser: ElasticsearchClient;
        asCurrentUser: ElasticsearchClient;
      };
      resources: ObservabilityAIAssistantResourceNames;
      logger: Logger;
      user: {
        id?: string;
        name: string;
      };
      knowledgeBaseService: KnowledgeBaseService;
    }
  ) {}

  private getConversationWithMetaFields = async (
    conversationId: string
  ): Promise<SearchHit<Conversation> | undefined> => {
    const response = await this.dependencies.esClient.asInternalUser.search<Conversation>({
      index: this.dependencies.resources.aliases.conversations,
      query: {
        bool: {
          filter: [
            ...getAccessQuery({
              user: this.dependencies.user,
              namespace: this.dependencies.namespace,
            }),
            { term: { 'conversation.id': conversationId } },
          ],
        },
      },
      size: 1,
      terminate_after: 1,
    });

    return response.hits.hits[0];
  };

  private getConversationUpdateValues = (now: string) => {
    return {
      conversation: {
        last_updated: now,
      },
      user: this.dependencies.user,
      namespace: this.dependencies.namespace,
    };
  };

  get = async (conversationId: string): Promise<Conversation> => {
    const conversation = await this.getConversationWithMetaFields(conversationId);

    if (!conversation) {
      throw notFound();
    }
    return conversation._source!;
  };

  delete = async (conversationId: string): Promise<void> => {
    const conversation = await this.getConversationWithMetaFields(conversationId);

    if (!conversation) {
      throw notFound();
    }

    await this.dependencies.esClient.asInternalUser.delete({
      id: conversation._id,
      index: conversation._index,
      refresh: true,
    });
  };

  complete = (
    params: {
      messages: Message[];
      connectorId: string;
      signal: AbortSignal;
      functionClient: ChatFunctionClient;
      persist: boolean;
    } & ({ conversationId: string } | { title?: string })
  ): Observable<Exclude<StreamingChatResponseEvent, ChatCompletionErrorEvent>> => {
    return new Observable<Exclude<StreamingChatResponseEvent, ChatCompletionErrorEvent>>(
      (subscriber) => {
        const { messages, connectorId, signal, functionClient, persist } = params;

        let conversationId: string = '';
        let title: string = '';
        if ('conversationId' in params) {
          conversationId = params.conversationId;
        }

        if ('title' in params) {
          title = params.title || '';
        }

        let numFunctionsCalled: number = 0;

        const MAX_FUNCTION_CALLS = 5;
        const MAX_FUNCTION_RESPONSE_TOKEN_COUNT = 4000;

        const next = async (nextMessages: Message[]): Promise<void> => {
          const lastMessage = last(nextMessages);

          const isUserMessage = lastMessage?.message.role === MessageRole.User;

          const isUserMessageWithoutFunctionResponse = isUserMessage && !lastMessage?.message.name;

          const contextFirst =
            isUserMessageWithoutFunctionResponse && functionClient.hasFunction('context');

          const isAssistantMessageWithFunctionRequest =
            lastMessage?.message.role === MessageRole.Assistant &&
            !!lastMessage?.message.function_call?.name;

          if (contextFirst) {
            const addedMessage = {
              '@timestamp': new Date().toISOString(),
              message: {
                role: MessageRole.Assistant,
                content: '',
                function_call: {
                  name: 'context',
                  arguments: JSON.stringify({
                    queries: [],
                    categories: [],
                  }),
                  trigger: MessageRole.Assistant as const,
                },
              },
            };

            subscriber.next({
              type: StreamingChatResponseEventType.MessageAdd,
              id: v4(),
              message: addedMessage,
            });

            return await next(nextMessages.concat(addedMessage));
          } else if (isUserMessage) {
            const functions =
              numFunctionsCalled >= MAX_FUNCTION_CALLS
                ? []
                : functionClient
                    .getFunctions()
                    .filter((fn) => {
                      const visibility = fn.definition.visibility ?? FunctionVisibility.All;
                      return (
                        visibility === FunctionVisibility.All ||
                        visibility === FunctionVisibility.AssistantOnly
                      );
                    })
                    .map((fn) => pick(fn.definition, 'name', 'description', 'parameters'));

            if (numFunctionsCalled >= MAX_FUNCTION_CALLS) {
              this.dependencies.logger.debug(
                `Max function calls exceeded, no longer sending over functions`
              );
            }

            const response$ = (
              await this.chat(
                lastMessage.message.name && lastMessage.message.name !== 'context'
                  ? 'function_response'
                  : 'user_message',
                {
                  messages: nextMessages,
                  connectorId,
                  signal,
                  functions,
                }
              )
            ).pipe(emitWithConcatenatedMessage(), shareReplay());

            response$.subscribe({
              next: (val) => subscriber.next(val),
              // we handle the error below
              error: noop,
            });

            const emittedMessageEvents = await lastValueFrom(
              response$.pipe(
                filter(
                  (event): event is MessageAddEvent =>
                    event.type === StreamingChatResponseEventType.MessageAdd
                ),
                toArray()
              )
            );

            return await next(
              nextMessages.concat(emittedMessageEvents.map((event) => event.message))
            );
          }

          if (isAssistantMessageWithFunctionRequest) {
            const span = apm.startSpan(
              `execute_function ${lastMessage.message.function_call!.name}`
            );

            span?.addLabels({
              ai_assistant_args: JSON.stringify(lastMessage.message.function_call!.arguments ?? {}),
            });

            const functionResponse =
              numFunctionsCalled >= MAX_FUNCTION_CALLS
                ? {
                    content: {
                      error: {},
                      message: 'Function limit exceeded, ask the user what to do next',
                    },
                  }
                : await functionClient
                    .executeFunction({
                      connectorId,
                      name: lastMessage.message.function_call!.name,
                      messages: nextMessages,
                      args: lastMessage.message.function_call!.arguments,
                      signal,
                    })
                    .then((response) => {
                      if (isObservable(response)) {
                        return response;
                      }

                      span?.setOutcome('success');

                      const encoded = encode(JSON.stringify(response.content || {}));

                      if (encoded.length <= MAX_FUNCTION_RESPONSE_TOKEN_COUNT) {
                        return response;
                      }

                      return {
                        data: response.data,
                        content: {
                          message:
                            'Function response exceeded the maximum length allowed and was truncated',
                          truncated: decode(take(encoded, MAX_FUNCTION_RESPONSE_TOKEN_COUNT)),
                        },
                      };
                    })
                    .catch((error): FunctionResponse => {
                      span?.setOutcome('failure');
                      return {
                        content: {
                          message: error.toString(),
                          error,
                        },
                      };
                    });

            numFunctionsCalled++;

            if (signal.aborted) {
              return;
            }

            if (isObservable(functionResponse)) {
              const shared = functionResponse.pipe(shareReplay());

              shared.subscribe({
                next: (val) => subscriber.next(val),
                // we handle the error below
                error: noop,
              });

              const messageEvents = await lastValueFrom(
                shared.pipe(
                  filter(
                    (event): event is MessageAddEvent =>
                      event.type === StreamingChatResponseEventType.MessageAdd
                  ),
                  toArray()
                )
              );

              span?.end();

              return await next(nextMessages.concat(messageEvents.map((event) => event.message)));
            }

            const functionResponseMessage = {
              '@timestamp': new Date().toISOString(),
              message: {
                name: lastMessage.message.function_call!.name,

                content: JSON.stringify(functionResponse.content || {}),
                data: functionResponse.data ? JSON.stringify(functionResponse.data) : undefined,
                role: MessageRole.User,
              },
            };

            this.dependencies.logger.debug(
              `Function response: ${JSON.stringify(functionResponseMessage, null, 2)}`
            );
            nextMessages = nextMessages.concat(functionResponseMessage);

            subscriber.next({
              type: StreamingChatResponseEventType.MessageAdd,
              message: functionResponseMessage,
              id: v4(),
            });

            span?.end();

            return await next(nextMessages);
          }

          this.dependencies.logger.debug(`Conversation: ${JSON.stringify(nextMessages, null, 2)}`);

          if (!persist) {
            subscriber.complete();
            return;
          }

          // store the updated conversation and close the stream
          if (conversationId) {
            const conversation = await this.getConversationWithMetaFields(conversationId);
            if (!conversation) {
              throw createConversationNotFoundError();
            }

            if (signal.aborted) {
              return;
            }

            const updatedConversation = await this.update(
              merge({}, omit(conversation._source, 'messages'), { messages: nextMessages })
            );
            subscriber.next({
              type: StreamingChatResponseEventType.ConversationUpdate,
              conversation: updatedConversation.conversation,
            });
          } else {
            const generatedTitle = await titlePromise;
            if (signal.aborted) {
              return;
            }

            const conversation = await this.create({
              '@timestamp': new Date().toISOString(),
              conversation: {
                title: generatedTitle || title || 'New conversation',
              },
              messages: nextMessages,
              labels: {},
              numeric_labels: {},
              public: false,
            });

            subscriber.next({
              type: StreamingChatResponseEventType.ConversationCreate,
              conversation: conversation.conversation,
            });
          }

          subscriber.complete();
        };

        next(messages).catch((error) => {
          if (!signal.aborted) {
            this.dependencies.logger.error(error);
          }
          subscriber.error(error);
        });

        const titlePromise =
          !conversationId && !title && persist
            ? this.getGeneratedTitle({
                messages,
                connectorId,
                signal,
              }).catch((error) => {
                this.dependencies.logger.error(
                  'Could not generate title, falling back to default title'
                );
                this.dependencies.logger.error(error);
                return Promise.resolve(undefined);
              })
            : Promise.resolve(undefined);
      }
    ).pipe(shareReplay());
  };

  chat = async (
    name: string,
    {
      messages,
      connectorId,
      functions,
      functionCall,
      signal,
    }: {
      messages: Message[];
      connectorId: string;
      functions?: Array<{ name: string; description: string; parameters: CompatibleJSONSchema }>;
      functionCall?: string;
      signal: AbortSignal;
    }
  ): Promise<Observable<ChatCompletionChunkEvent>> => {
    const span = apm.startSpan(`chat ${name}`);

    const spanId = (span?.ids['span.id'] || '').substring(0, 6);

    const loggerPrefix = `${name}${spanId ? ` (${spanId})` : ''}`;

    try {
      const connector = await this.dependencies.actionsClient.get({
        id: connectorId,
      });

      let adapter: LlmApiAdapter;

      switch (connector.actionTypeId) {
        case ObservabilityAIAssistantConnectorType.OpenAI:
          adapter = createOpenAiAdapter({
            logger: this.dependencies.logger,
            messages,
            functionCall,
            functions,
          });
          break;

        case ObservabilityAIAssistantConnectorType.Bedrock:
          adapter = createBedrockClaudeAdapter({
            logger: this.dependencies.logger,
            messages,
            functionCall,
            functions,
          });
          break;

        default:
          throw new Error(`Connector type is not supported: ${connector.actionTypeId}`);
      }

      const subAction = adapter.getSubAction();

      this.dependencies.logger.debug(`${loggerPrefix}: Sending conversation to connector`);
      this.dependencies.logger.trace(
        `${loggerPrefix}:\n${JSON.stringify(subAction.subActionParams, null, 2)}`
      );

      const now = performance.now();

      const executeResult = await this.dependencies.actionsClient.execute({
        actionId: connectorId,
        params: subAction,
      });

      this.dependencies.logger.debug(
        `${loggerPrefix}: Received action client response: ${
          executeResult.status
        } (took: ${Math.round(performance.now() - now)}ms)`
      );

      if (executeResult.status === 'error' && executeResult?.serviceMessage) {
        const tokenLimitRegex =
          /This model's maximum context length is (\d+) tokens\. However, your messages resulted in (\d+) tokens/g;
        const tokenLimitRegexResult = tokenLimitRegex.exec(executeResult.serviceMessage);

        if (tokenLimitRegexResult) {
          const [, tokenLimit, tokenCount] = tokenLimitRegexResult;
          throw createTokenLimitReachedError(parseInt(tokenLimit, 10), parseInt(tokenCount, 10));
        }
      }

      if (executeResult.status === 'error') {
        throw internal(`${executeResult?.message} - ${executeResult?.serviceMessage}`);
      }

      const response = executeResult.data as Readable;

      signal.addEventListener('abort', () => response.destroy());

      const response$ = adapter.streamIntoObservable(response).pipe(shareReplay());

      response$.pipe(concatenateChatCompletionChunks(), lastOperator()).subscribe({
        error: (error) => {
          this.dependencies.logger.debug(`${loggerPrefix}: Error in chat response`);
          this.dependencies.logger.debug(error);
        },
        next: (message) => {
          this.dependencies.logger.debug(
            `${loggerPrefix}: Received message:\n${JSON.stringify(message)}`
          );
        },
      });

      lastValueFrom(response$)
        .then(() => {
          span?.setOutcome('success');
        })
        .catch(() => {
          span?.setOutcome('failure');
        })
        .finally(() => {
          span?.end();
        });

      return response$;
    } catch (error) {
      span?.setOutcome('failure');
      span?.end();
      throw error;
    }
  };

  find = async (options?: { query?: string }): Promise<{ conversations: Conversation[] }> => {
    const response = await this.dependencies.esClient.asInternalUser.search<Conversation>({
      index: this.dependencies.resources.aliases.conversations,
      allow_no_indices: true,
      query: {
        bool: {
          filter: [
            ...getAccessQuery({
              user: this.dependencies.user,
              namespace: this.dependencies.namespace,
            }),
          ],
        },
      },
      sort: {
        '@timestamp': 'desc',
      },
      size: 100,
    });

    return {
      conversations: response.hits.hits.map((hit) => hit._source!),
    };
  };

  update = async (conversation: ConversationUpdateRequest): Promise<Conversation> => {
    const document = await this.getConversationWithMetaFields(conversation.conversation.id);

    if (!document) {
      throw notFound();
    }

    const updatedConversation: Conversation = merge(
      {},
      conversation,
      this.getConversationUpdateValues(new Date().toISOString())
    );

    await this.dependencies.esClient.asInternalUser.update({
      id: document._id,
      index: document._index,
      doc: updatedConversation,
      refresh: true,
    });

    return updatedConversation;
  };

  getGeneratedTitle = async ({
    messages,
    connectorId,
    signal,
  }: {
    messages: Message[];
    connectorId: string;
    signal: AbortSignal;
  }) => {
    const response$ = await this.chat('generate_title', {
      messages: [
        {
          '@timestamp': new Date().toString(),
          message: {
            role: MessageRole.System,
            content: `You are a helpful assistant for Elastic Observability. Assume the following message is the start of a conversation between you and a user; give this conversation a title based on the content below. DO NOT UNDER ANY CIRCUMSTANCES wrap this title in single or double quotes. This title is shown in a list of conversations to the user, so title it for the user, not for you.`,
          },
        },
        {
          '@timestamp': new Date().toISOString(),
          message: {
            role: MessageRole.User,
            content: messages.slice(1).reduce((acc, curr) => {
              return `${acc} ${curr.message.role}: ${curr.message.content}`;
            }, 'Generate a title, using the title_conversation_function, based on the following conversation:\n\n'),
          },
        },
      ],
      functions: [
        {
          name: 'title_conversation',
          description:
            'Use this function to title the conversation. Do not wrap the title in quotes',
          parameters: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
              },
            },
            required: ['title'],
          },
        },
      ],
      connectorId,
      signal,
    });

    const response = await lastValueFrom(response$.pipe(concatenateChatCompletionChunks()));

    const input =
      (response.message.function_call.name
        ? JSON.parse(response.message.function_call.arguments).title
        : response.message?.content) || '';

    // This regular expression captures a string enclosed in single or double quotes.
    // It extracts the string content without the quotes.
    // Example matches:
    // - "Hello, World!" => Captures: Hello, World!
    // - 'Another Example' => Captures: Another Example
    // - JustTextWithoutQuotes => Captures: JustTextWithoutQuotes
    const match = input.match(/^["']?([^"']+)["']?$/);
    const title = match ? match[1] : input;
    return title;
  };

  setTitle = async ({ conversationId, title }: { conversationId: string; title: string }) => {
    const document = await this.getConversationWithMetaFields(conversationId);
    if (!document) {
      throw notFound();
    }

    const conversation = await this.get(conversationId);

    if (!conversation) {
      throw notFound();
    }

    const updatedConversation: Conversation = merge(
      {},
      conversation,
      { conversation: { title } },
      this.getConversationUpdateValues(new Date().toISOString())
    );

    await this.dependencies.esClient.asInternalUser.update({
      id: document._id,
      index: document._index,
      doc: { conversation: { title } },
      refresh: true,
    });

    return updatedConversation;
  };

  create = async (conversation: ConversationCreateRequest): Promise<Conversation> => {
    const now = new Date().toISOString();

    const createdConversation: Conversation = merge(
      {},
      conversation,
      {
        '@timestamp': now,
        conversation: { id: v4() },
      },
      this.getConversationUpdateValues(now)
    );

    await this.dependencies.esClient.asInternalUser.index({
      index: this.dependencies.resources.aliases.conversations,
      document: createdConversation,
      refresh: true,
    });

    return createdConversation;
  };

  recall = async ({
    queries,
    categories,
  }: {
    queries: string[];
    categories?: string[];
  }): Promise<{ entries: RecalledEntry[] }> => {
    return this.dependencies.knowledgeBaseService.recall({
      namespace: this.dependencies.namespace,
      user: this.dependencies.user,
      queries,
      categories,
      asCurrentUser: this.dependencies.esClient.asCurrentUser,
    });
  };

  getKnowledgeBaseStatus = () => {
    return this.dependencies.knowledgeBaseService.status();
  };

  setupKnowledgeBase = () => {
    return this.dependencies.knowledgeBaseService.setup();
  };

  createKnowledgeBaseEntry = async ({
    entry,
  }: {
    entry: Omit<KnowledgeBaseEntry, '@timestamp'>;
  }): Promise<void> => {
    return this.dependencies.knowledgeBaseService.addEntry({
      namespace: this.dependencies.namespace,
      user: this.dependencies.user,
      entry,
    });
  };

  importKnowledgeBaseEntries = async ({
    entries,
  }: {
    entries: Array<Omit<KnowledgeBaseEntry, '@timestamp'>>;
  }): Promise<void> => {
    const operations = entries.map((entry) => ({
      type: KnowledgeBaseEntryOperationType.Index,
      document: { ...entry, '@timestamp': new Date().toISOString() },
    }));

    await this.dependencies.knowledgeBaseService.addEntries({ operations });
  };

  getKnowledgeBaseEntries = async ({
    query,
    sortBy,
    sortDirection,
  }: {
    query: string;
    sortBy: string;
    sortDirection: 'asc' | 'desc';
  }) => {
    return this.dependencies.knowledgeBaseService.getEntries({ query, sortBy, sortDirection });
  };

  deleteKnowledgeBaseEntry = async (id: string) => {
    return this.dependencies.knowledgeBaseService.deleteEntry({ id });
  };
}
