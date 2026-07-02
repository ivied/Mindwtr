import {
    buildSaveSnapshot,
    ensureDeviceId,
    getNextDataChangeAt,
    nextRevision,
    selectVisiblePeople,
    selectVisibleTasks,
} from '../store-helpers';
import { logWarn } from '../logger';
import { clearDerivedCache } from '../store-settings';
import { getPersonNameKey, normalizePersonName, normalizePersonNote, normalizePersonReferenceLink } from '../people';
import { generateUUID as uuidv4 } from '../uuid';
import type { PeopleActions, Person, ProjectActionContext } from './shared';
import { actionFail, actionOk } from './shared';

export const createPeopleActions = ({
    set,
    get,
    debouncedSave,
}: ProjectActionContext): PeopleActions => ({
    addPerson: async (name: string, initialProps?: Partial<Person>) => {
        const trimmedName = normalizePersonName(name);
        if (!trimmedName) return null;
        const normalized = getPersonNameKey(trimmedName);
        const now = new Date().toISOString();
        const changeAt = Date.now();
        let snapshot = null;
        let createdPerson: Person | null = null;
        let existingPersonId: string | null = null;
        let shouldRestoreDeletedPerson = false;

        set((state) => {
            const existingActive = state._allPeople.find((person) => !person.deletedAt && getPersonNameKey(person.name) === normalized);
            if (existingActive) {
                existingPersonId = existingActive.id;
                return state;
            }
            const existingDeleted = state._allPeople.find((person) => person.deletedAt && getPersonNameKey(person.name) === normalized);
            if (existingDeleted) {
                existingPersonId = existingDeleted.id;
                shouldRestoreDeletedPerson = true;
                return state;
            }

            const deviceState = ensureDeviceId(state.settings);
            const newPerson: Person = {
                id: uuidv4(),
                ...initialProps,
                name: trimmedName,
                note: normalizePersonNote(initialProps?.note),
                referenceLink: normalizePersonReferenceLink(initialProps?.referenceLink),
                rev: 1,
                revBy: deviceState.deviceId,
                createdAt: initialProps?.createdAt ?? now,
                updatedAt: now,
            };
            createdPerson = newPerson;
            const newAllPeople = [...state._allPeople, newPerson];
            snapshot = buildSaveSnapshot(state, {
                people: newAllPeople,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                people: selectVisiblePeople(newAllPeople),
                _allPeople: newAllPeople,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (existingPersonId) {
            if (shouldRestoreDeletedPerson) {
                const result = await get().updatePerson(existingPersonId, {
                    ...(initialProps ?? {}),
                    name: trimmedName,
                    deletedAt: undefined,
                });
                if (!result.success) return null;
            }
            const resolved = get()._allPeople.find((person) => person.id === existingPersonId);
            return resolved && !resolved.deletedAt ? resolved : null;
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return createdPerson;
    },

    updatePerson: async (id: string, updates: Partial<Person>) => {
        let snapshot = null;
        let missingPerson = false;
        let invalidName = false;
        set((state) => {
            const person = state._allPeople.find((item) => item.id === id);
            if (!person) {
                missingPerson = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const nextName = updates.name !== undefined ? normalizePersonName(updates.name) : person.name;
            if (!nextName) {
                invalidName = true;
                return state;
            }
            const hasNoteUpdate = Object.prototype.hasOwnProperty.call(updates, 'note');
            const hasReferenceLinkUpdate = Object.prototype.hasOwnProperty.call(updates, 'referenceLink');
            const now = new Date().toISOString();
            const normalizedUpdates: Partial<Person> = {
                ...updates,
                name: nextName,
                note: hasNoteUpdate ? normalizePersonNote(updates.note) : person.note,
                referenceLink: hasReferenceLinkUpdate ? normalizePersonReferenceLink(updates.referenceLink) : person.referenceLink,
            };
            const nextAllPeople = state._allPeople.map((item) => (
                item.id === id
                    ? {
                        ...item,
                        ...normalizedUpdates,
                        updatedAt: now,
                        rev: nextRevision(item.rev),
                        revBy: deviceState.deviceId,
                    }
                    : item
            ));
            snapshot = buildSaveSnapshot(state, {
                people: nextAllPeople,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                people: selectVisiblePeople(nextAllPeople),
                _allPeople: nextAllPeople,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingPerson) {
            const message = 'Person not found';
            logWarn('updatePerson skipped: person not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        if (invalidName) {
            const message = 'Person name is required';
            set({ error: message });
            return actionFail(message);
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    renamePerson: async (id: string, name: string, options?: { updateTasks?: boolean }) => {
        const nextName = normalizePersonName(name);
        if (!nextName) {
            const message = 'Person name is required';
            set({ error: message });
            return actionFail(message);
        }
        const now = new Date().toISOString();
        const changeAt = Date.now();
        let snapshot = null;
        let missingPerson = false;
        set((state) => {
            const person = state._allPeople.find((item) => item.id === id);
            if (!person) {
                missingPerson = true;
                return state;
            }
            const oldKey = getPersonNameKey(person.name);
            const nextKey = getPersonNameKey(nextName);
            if (oldKey === nextKey && person.name === nextName) return state;
            const deviceState = ensureDeviceId(state.settings);
            const existingTarget = state._allPeople.find((item) => item.id !== id && !item.deletedAt && getPersonNameKey(item.name) === nextKey);
            let nextAllPeople: Person[];
            if (existingTarget) {
                const deletedPerson: Person = {
                    ...person,
                    deletedAt: now,
                    updatedAt: now,
                    rev: nextRevision(person.rev),
                    revBy: deviceState.deviceId,
                };
                const mergedPerson: Person = {
                    ...existingTarget,
                    note: existingTarget.note ?? person.note,
                    referenceLink: existingTarget.referenceLink ?? person.referenceLink,
                    updatedAt: now,
                    rev: nextRevision(existingTarget.rev),
                    revBy: deviceState.deviceId,
                };
                nextAllPeople = state._allPeople.map((item) => {
                    if (item.id === id) return deletedPerson;
                    if (item.id === existingTarget.id) return mergedPerson;
                    return item;
                });
            } else {
                nextAllPeople = state._allPeople.map((item) => (
                    item.id === id
                        ? {
                            ...item,
                            name: nextName,
                            updatedAt: now,
                            rev: nextRevision(item.rev),
                            revBy: deviceState.deviceId,
                        }
                        : item
                ));
            }

            let nextAllTasks = state._allTasks;
            if (options?.updateTasks !== false) {
                nextAllTasks = state._allTasks.map((task) => {
                    if (task.deletedAt || getPersonNameKey(task.assignedTo) !== oldKey) return task;
                    return {
                        ...task,
                        assignedTo: nextName,
                        updatedAt: now,
                        rev: nextRevision(task.rev),
                        revBy: deviceState.deviceId,
                    };
                });
            }

            clearDerivedCache();
            snapshot = buildSaveSnapshot(state, {
                people: nextAllPeople,
                tasks: nextAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                people: selectVisiblePeople(nextAllPeople),
                _allPeople: nextAllPeople,
                tasks: selectVisibleTasks(nextAllTasks),
                _allTasks: nextAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingPerson) {
            const message = 'Person not found';
            set({ error: message });
            return actionFail(message);
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    deletePerson: async (id: string) => {
        const now = new Date().toISOString();
        const changeAt = Date.now();
        let snapshot = null;
        let missingPerson = false;
        set((state) => {
            const person = state._allPeople.find((item) => item.id === id);
            if (!person || person.deletedAt) {
                missingPerson = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const nextAllPeople = state._allPeople.map((item) => (
                item.id === id
                    ? {
                        ...item,
                        deletedAt: now,
                        updatedAt: now,
                        rev: nextRevision(item.rev),
                        revBy: deviceState.deviceId,
                    }
                    : item
            ));
            snapshot = buildSaveSnapshot(state, {
                people: nextAllPeople,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                people: selectVisiblePeople(nextAllPeople),
                _allPeople: nextAllPeople,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingPerson) {
            const message = 'Person not found';
            set({ error: message });
            return actionFail(message);
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    restorePerson: async (id: string) => {
        const now = new Date().toISOString();
        const changeAt = Date.now();
        let snapshot = null;
        let missingPerson = false;
        let duplicateActivePerson = false;
        set((state) => {
            const person = state._allPeople.find((item) => item.id === id);
            if (!person) {
                missingPerson = true;
                return state;
            }
            if (!person.deletedAt) {
                return state;
            }
            const restoredNameKey = getPersonNameKey(person.name);
            const existingActive = state._allPeople.find((item) => (
                item.id !== id
                && !item.deletedAt
                && getPersonNameKey(item.name) === restoredNameKey
            ));
            if (existingActive) {
                duplicateActivePerson = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const nextAllPeople = state._allPeople.map((item) => (
                item.id === id
                    ? {
                        ...item,
                        deletedAt: undefined,
                        updatedAt: now,
                        rev: nextRevision(item.rev),
                        revBy: deviceState.deviceId,
                    }
                    : item
            ));
            snapshot = buildSaveSnapshot(state, {
                people: nextAllPeople,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                people: selectVisiblePeople(nextAllPeople),
                _allPeople: nextAllPeople,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingPerson) {
            const message = 'Person not found';
            set({ error: message });
            return actionFail(message);
        }
        if (duplicateActivePerson) {
            const message = 'A person with this name already exists';
            set({ error: message });
            return actionFail(message);
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },
});
