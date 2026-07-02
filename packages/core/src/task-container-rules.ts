export type TaskContainerAssignment = {
    projectId?: string;
    sectionId?: string;
    areaId?: string;
};

export const resolveTaskContainerHierarchy = ({
    projectId,
    sectionId,
    areaId,
    sectionProjectId,
}: TaskContainerAssignment & { sectionProjectId?: string }): TaskContainerAssignment => {
    let nextProjectId = projectId;
    let nextSectionId = sectionId;
    let nextAreaId = areaId;

    if (nextSectionId) {
        if (!sectionProjectId) {
            nextSectionId = undefined;
        } else if (!nextProjectId) {
            nextProjectId = sectionProjectId;
            nextAreaId = undefined;
        } else if (sectionProjectId !== nextProjectId) {
            nextSectionId = undefined;
        }
    }

    if (nextAreaId && nextProjectId) {
        nextAreaId = undefined;
    }

    return {
        projectId: nextProjectId,
        sectionId: nextSectionId,
        areaId: nextAreaId,
    };
};
