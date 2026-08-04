import { useEffect, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Button,
    FlatList,
    SafeAreaView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import {
    createLiveOntology,
    type LiveOntology,
} from "@party-stack/ontology";
import { createCloudKitOntologyBackend } from "@party-stack/cloudkit-ontology";
import { CloudKitError } from "@party-stack/cloudkit-client";
import { useLiveQuery } from "@tanstack/react-db";
import { journalOntology } from "./src/ontology";
import {
    createJournalPlatformServices,
    type JournalPlatformServices,
} from "./src/platform";

interface Entry {
    id: string;
    title: string;
    body: string;
    mood: string;
}

function displayError(error: unknown): string {
    if (error instanceof CloudKitError) {
        const details = error.details
            ? `\n${JSON.stringify(error.details, null, 2)}`
            : "";
        return `${error.code}: ${error.message}${details}`;
    }
    return error instanceof Error ? error.message : String(error);
}

function Journal({
    ontology,
    platformDescription,
}: {
    ontology: LiveOntology;
    platformDescription: string;
}) {
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [mood, setMood] = useState("calm");
    const [actionError, setActionError] = useState<string>();
    const [selectedEntryId, setSelectedEntryId] = useState<
        string | undefined
    >();
    const { data } = useLiveQuery(
        (query) =>
            query
                .from({
                    entry: ontology.objects.JournalEntry!,
                })
                .select(({ entry }) => ({ ...entry }))
                .orderBy(
                    ({ entry }) => entry.updatedAt,
                    "desc"
                ),
        [ontology]
    );
    const entries = data as unknown as Entry[];

    async function createEntry() {
        try {
            setActionError(undefined);
            const id = crypto.randomUUID();
            await ontology.actions.createEntry!({
                id,
                title: title.trim() || "Untitled",
                body,
                mood,
            });
            setSelectedEntryId(id);
            setTitle("");
            setBody("");
        } catch (error) {
            console.error("Failed to save journal entry.", error);
            setActionError(displayError(error));
        }
    }

    async function attachFile() {
        if (!selectedEntryId) {
            Alert.alert(
                "Select an entry",
                "Tap an entry before attaching a file."
            );
            return;
        }
        const result = await DocumentPicker.getDocumentAsync({
            copyToCacheDirectory: true,
        });
        if (result.canceled) return;
        const picked = result.assets[0]!;
        const response = await fetch(picked.uri);
        const blob = await response.blob();
        const creation = await ontology.attachments.create(blob, {
            target: {
                kind: "objectProperty",
                objectType: "JournalAttachment",
                property: "attachment",
            },
        });
        await ontology.actions.attachFile!({
            id: crypto.randomUUID(),
            entry: selectedEntryId,
            attachment: creation.attachment,
        });
        Alert.alert("Attached", picked.name);
    }

    async function deleteEntry(id: string) {
        try {
            setActionError(undefined);
            await ontology.actions.deleteEntry!({ entry: id });
        } catch (error) {
            console.error("Failed to delete journal entry.", error);
            setActionError(displayError(error));
        }
    }

    return (
        <SafeAreaView style={styles.screen}>
            <View style={styles.header}>
                <Text style={styles.title}>CloudKit Journal</Text>
                <Text style={styles.subtitle}>
                    {platformDescription}
                </Text>
            </View>
            <View style={styles.form}>
                <TextInput
                    placeholder="Title"
                    placeholderTextColor="#64748b"
                    value={title}
                    onChangeText={setTitle}
                    style={styles.input}
                />
                <TextInput
                    placeholder="How was your day?"
                    placeholderTextColor="#64748b"
                    value={body}
                    onChangeText={setBody}
                    multiline
                    style={[styles.input, styles.bodyInput]}
                />
                <TextInput
                    placeholder="Mood"
                    placeholderTextColor="#64748b"
                    value={mood}
                    onChangeText={setMood}
                    style={styles.input}
                />
                <View style={styles.actions}>
                    <Button title="Save entry" onPress={createEntry} />
                    <Button
                        title="Attach file"
                        onPress={attachFile}
                    />
                </View>
                {actionError ? (
                    <Text style={styles.error}>{actionError}</Text>
                ) : null}
            </View>
            <FlatList
                data={entries}
                keyExtractor={(entry) => entry.id}
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                    <Text style={styles.empty}>
                        Your private iCloud journal is empty.
                    </Text>
                }
                renderItem={({ item }) => (
                    <View
                        style={[
                            styles.card,
                            selectedEntryId === item.id &&
                                styles.selectedCard,
                        ]}
                    >
                        <Text
                            style={styles.cardTitle}
                            onPress={() =>
                                setSelectedEntryId(item.id)
                            }
                        >
                            {item.title}
                        </Text>
                        <Text style={styles.mood}>{item.mood}</Text>
                        <Text style={styles.body}>{item.body}</Text>
                        <Button
                            title="Delete"
                            color="#ef4444"
                            onPress={() => void deleteEntry(item.id)}
                        />
                    </View>
                )}
            />
        </SafeAreaView>
    );
}

export default function App() {
    const [services, setServices] =
        useState<JournalPlatformServices>();
    const [ontology, setOntology] = useState<LiveOntology>();
    const [error, setError] = useState<string>();

    useEffect(() => {
        let disposed = false;
        let createdOntology: LiveOntology | undefined;
        void createJournalPlatformServices()
            .then(async (nextServices) => {
                if (disposed) return;
                setServices(nextServices);
                if (nextServices.accountStatus !== "available") {
                    return;
                }
                createdOntology = await createLiveOntology({
                    id: "cloudkit-journal",
                    ir: journalOntology,
                    backend: createCloudKitOntologyBackend({
                        client: nextServices.client,
                        pollIntervalMs: 2_000,
                    }),
                    runtime: nextServices.runtime,
                    persistObjects: true,
                    writes: {
                        defaultMode: "outbox",
                        defaultVisibility: "optimistic",
                        outbox: {
                            maxRetries: 0,
                        },
                    },
                    context: { userId: "icloud-user" },
                    getUserId: (context) => context.userId,
                });
                if (disposed) {
                    await createdOntology.cleanup();
                    return;
                }
                setOntology(createdOntology);
            })
            .catch((reason: unknown) => {
                setError(
                    reason instanceof Error
                        ? reason.message
                        : String(reason)
                );
            });
        return () => {
            disposed = true;
            if (createdOntology) {
                void createdOntology.cleanup();
            }
        };
    }, []);

    if (error) {
        return (
            <SafeAreaView style={styles.centered}>
                <Text style={styles.errorTitle}>
                    CloudKit needs attention
                </Text>
                <Text style={styles.error}>{error}</Text>
            </SafeAreaView>
        );
    }
    if (
        services &&
        services.accountStatus !== "available"
    ) {
        return (
            <SafeAreaView style={styles.centered}>
                <Text style={styles.errorTitle}>
                    Sign in to iCloud
                </Text>
                <Text style={styles.loading}>
                    Account status: {services.accountStatus}
                </Text>
                {services.signIn ? (
                    <Button
                        title="Continue with Apple"
                        onPress={() => {
                            try {
                                services.signIn?.();
                            } catch (reason) {
                                setError(
                                    reason instanceof Error
                                        ? reason.message
                                        : String(reason)
                                );
                            }
                        }}
                    />
                ) : (
                    <Text style={styles.error}>
                        Sign into iCloud in Settings and enable
                        iCloud Drive.
                    </Text>
                )}
            </SafeAreaView>
        );
    }
    if (!ontology || !services) {
        return (
            <SafeAreaView style={styles.centered}>
                <ActivityIndicator size="large" />
                <Text style={styles.loading}>
                    Connecting to iCloud…
                </Text>
            </SafeAreaView>
        );
    }
    return (
        <Journal
            ontology={ontology}
            platformDescription={services.platformDescription}
        />
    );
}

const styles = StyleSheet.create({
    screen: {
        flex: 1,
        backgroundColor: "#020617",
    },
    centered: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 32,
        backgroundColor: "#020617",
    },
    header: {
        paddingHorizontal: 20,
        paddingVertical: 16,
    },
    title: {
        color: "#f8fafc",
        fontSize: 28,
        fontWeight: "700",
    },
    subtitle: {
        color: "#94a3b8",
        marginTop: 4,
    },
    form: {
        gap: 10,
        paddingHorizontal: 20,
    },
    input: {
        borderColor: "#334155",
        borderWidth: 1,
        borderRadius: 12,
        color: "#f8fafc",
        padding: 12,
        backgroundColor: "#0f172a",
    },
    bodyInput: {
        minHeight: 90,
        textAlignVertical: "top",
    },
    actions: {
        flexDirection: "row",
        justifyContent: "space-between",
    },
    list: {
        gap: 12,
        padding: 20,
    },
    card: {
        gap: 8,
        borderColor: "#1e293b",
        borderWidth: 1,
        borderRadius: 16,
        padding: 16,
        backgroundColor: "#0f172a",
    },
    selectedCard: {
        borderColor: "#38bdf8",
    },
    cardTitle: {
        color: "#f8fafc",
        fontSize: 18,
        fontWeight: "600",
    },
    mood: {
        color: "#38bdf8",
    },
    body: {
        color: "#cbd5e1",
    },
    empty: {
        color: "#64748b",
        textAlign: "center",
        paddingTop: 40,
    },
    errorTitle: {
        color: "#f8fafc",
        fontSize: 20,
        fontWeight: "700",
    },
    error: {
        color: "#fca5a5",
        textAlign: "center",
    },
    loading: {
        color: "#cbd5e1",
    },
});
