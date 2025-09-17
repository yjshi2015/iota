// Copyright (c) 2025 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import { useZodForm } from '@iota/core';
import classNames from 'clsx';
import { type SubmitHandler } from 'react-hook-form';
import { z } from 'zod';

import { Form } from '../../shared/forms/Form';
import {
    Button,
    ButtonType,
    ButtonHtmlType,
    Input,
    InputType,
    ButtonSize,
    Dialog,
    DialogContent,
    Header,
    DialogBody,
} from '@iota/apps-ui-kit';
import {
    weightedPubKeyValidation,
    thresholdValidation,
} from '../../helpers/validation/multisigConfigValidation';
import { useEffect, useState } from 'react';
import { Close } from '@iota/apps-ui-icons';
import { UR } from '@keystonehq/keystone-sdk';
import { AnimatedQRCode } from '@keystonehq/animated-qr';

const formSchema = z
    .object({
        threshold: thresholdValidation,
        pubKeys: weightedPubKeyValidation,
    })
    .refine(
        (data) => {
            const threshold =
                typeof data.threshold === 'string' ? parseInt(data.threshold) || 0 : data.threshold;
            const totalWeight = data.pubKeys.reduce((sum, pk) => {
                const weight = typeof pk.weight === 'string' ? parseInt(pk.weight) || 0 : pk.weight;
                return sum + weight;
            }, 0);
            return threshold <= totalWeight;
        },
        {
            message: 'Threshold must not exceed the sum of all weights',
            path: ['threshold'],
        },
    );

type FormValues = z.infer<typeof formSchema>;

interface MultisigConfigFormProps {
    onSubmit: SubmitHandler<FormValues>;
    ourPubKey: string;
}

export function MultisigConfigureForm({ onSubmit, ourPubKey }: MultisigConfigFormProps) {
    const form = useZodForm({
        mode: 'all',
        reValidateMode: 'onChange',
        schema: formSchema,
        defaultValues: {
            threshold: 2,
            pubKeys: [{ pubKey: ourPubKey, weight: 1 }],
        },
    });

    const [isPublicKeyQrModalOpen, setIsPublicKeyQrModalOpen] = useState(false);

    const {
        register,
        formState: { isSubmitting, isValid, errors },
        watch,
        setValue,
        trigger,
    } = form;

    const pubKeys = watch('pubKeys');

    const addPubKey = () => {
        if (pubKeys.length < 10) {
            const newPubKeys = [...pubKeys, { pubKey: '', weight: 1 }];
            setValue('pubKeys', newPubKeys, { shouldValidate: true });
        }
    };

    const removePubKey = (index: number) => {
        if (pubKeys.length > 1) {
            const newPubKeys = pubKeys.filter((_, i) => i !== index);
            setValue('pubKeys', newPubKeys, { shouldValidate: true });
        }
    };

    const handleFormSubmit = (data: FormValues) => {
        onSubmit(data);
    };

    const totalWeight = pubKeys.reduce((sum, pk) => {
        const weight = typeof pk.weight === 'string' ? parseInt(pk.weight) || 0 : pk.weight;
        return sum + weight;
    }, 0);

    useEffect(() => {
        trigger('threshold');
    }, [totalWeight, trigger]);

    const ourPubKeyUR = UR.from(Buffer.from(ourPubKey));

    return (
        <>
            <Form className="flex h-full flex-col" form={form} onSubmit={handleFormSubmit}>
                <div className="flex-shrink-0">
                    <Input
                        type={InputType.Text}
                        label="Threshold"
                        min="1"
                        max="10"
                        {...register('threshold')}
                        errorMessage={errors.threshold?.message}
                    />
                </div>

                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="my-4 flex flex-shrink-0 items-center justify-between">
                        <label className="block text-sm font-medium text-gray-700">
                            <span className="ml-2 text-sm text-gray-500">
                                Total Weight: {totalWeight}
                            </span>
                        </label>
                        <Button
                            text="Add Public Key"
                            size={ButtonSize.Small}
                            onClick={addPubKey}
                            disabled={pubKeys.length >= 10}
                        />
                    </div>

                    <div className="max-h-[390px] flex-1 space-y-2 overflow-y-auto pr-1">
                        {pubKeys.map((pubKey, index) => (
                            <div
                                key={index}
                                className={classNames('rounded-lg border border-gray-200 p-2', {
                                    'border-green-200': pubKey.pubKey === ourPubKey,
                                })}
                            >
                                <div className="mb-1 flex items-center justify-between">
                                    <h4
                                        className={classNames('font-medium text-gray-700', {
                                            'text-green-500': pubKey.pubKey === ourPubKey,
                                        })}
                                    >
                                        {pubKey.pubKey === ourPubKey
                                            ? 'Your Public Key'
                                            : `Key #${index + 1}`}
                                    </h4>
                                    {pubKey.pubKey === ourPubKey && (
                                        <Button
                                            size={ButtonSize.Small}
                                            type={ButtonType.Secondary}
                                            onClick={() => setIsPublicKeyQrModalOpen(true)}
                                            text="Show QR"
                                        />
                                    )}
                                    {pubKeys.length > 1 && pubKey.pubKey !== ourPubKey && (
                                        <Button
                                            size={ButtonSize.Small}
                                            type={ButtonType.Destructive}
                                            onClick={() => removePubKey(index)}
                                            icon={<Close />}
                                        />
                                    )}
                                </div>

                                <div className="md:grid-cols-3 grid grid-cols-1 gap-2">
                                    <div className="md:col-span-2">
                                        <Input
                                            type={InputType.Text}
                                            placeholder="Enter public key"
                                            disabled={pubKey.pubKey === ourPubKey}
                                            {...register(`pubKeys.${index}.pubKey`)}
                                            errorMessage={errors.pubKeys?.[index]?.pubKey?.message}
                                        />
                                    </div>

                                    <div>
                                        <Input
                                            type={InputType.Number}
                                            label="Weight"
                                            min="1"
                                            max="10"
                                            {...register(`pubKeys.${index}.weight`)}
                                            errorMessage={errors.pubKeys?.[index]?.weight?.message}
                                        />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="mt-4 flex-shrink-0 pt-4">
                    <Button
                        htmlType={ButtonHtmlType.Submit}
                        type={ButtonType.Primary}
                        disabled={isSubmitting || !isValid}
                        fullWidth={true}
                        text={isSubmitting ? 'Submitting...' : 'Submit'}
                    />
                </div>
            </Form>
            <PublicKeyQrModal
                isOpen={isPublicKeyQrModalOpen}
                setOpen={(open) => setIsPublicKeyQrModalOpen(open)}
                pubKeyUR={ourPubKeyUR}
            />
        </>
    );
}

interface PublicKeyQrModalProps {
    isOpen: boolean;
    setOpen: (isOpen: boolean) => void;
    pubKeyUR: UR;
}

export function PublicKeyQrModal({ isOpen, setOpen, pubKeyUR }: PublicKeyQrModalProps) {
    return (
        <Dialog open={isOpen} onOpenChange={setOpen}>
            <DialogContent containerId="overlay-portal-container">
                <Header title="Public Key" onClose={() => setOpen(false)} />
                <DialogBody>
                    <div className="flex h-full flex-col items-center justify-center gap-xs">
                        <AnimatedQRCode
                            type={pubKeyUR.type}
                            cbor={pubKeyUR.cbor.toString('hex')}
                            options={{ size: 280, capacity: 1000 }}
                        />
                        <span className="text-title-xs mt-4 text-iota-neutral-10 dark:text-iota-neutral-92">
                            Scan this QR to get the Public Key of this account
                        </span>
                    </div>
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}
