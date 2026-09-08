import type { CanvasConnection, CanvasNodeData } from "../types";

/**
 * 智能分镜时序排序引擎
 * 针对用户在画布中框选或指定的多个视频镜头，按导演与编导逻辑综合判断最佳叙事顺序：
 * 1. 连线拓扑顺序：若节点间通过连线箭头存在明确的依赖/承接流向，严格遵循有向图流向；
 * 2. 标题分镜编号：若镜头标题带有分镜/镜头数字编号（如 "分镜 1", "镜头 02", "Shot 3"），按数字升序；
 * 3. 空间分镜板阅读顺序：按视觉行容差（Row Tolerance）自上而下、每行内自左向右排列。
 */
export function sortStoryboardVideoNodes(
    nodes: CanvasNodeData[],
    connections: CanvasConnection[] = []
): CanvasNodeData[] {
    if (!Array.isArray(nodes) || nodes.length <= 1) {
        return nodes || [];
    }

    // 1. 优先尝试拓扑/连线顺序（用户通过箭头将镜头串联成流水线）
    const nodeMap = new Map<string, CanvasNodeData>();
    const nodeIds = new Set<string>();
    nodes.forEach((n) => {
        nodeMap.set(n.id, n);
        nodeIds.add(n.id);
    });

    const outgoing = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    nodes.forEach((n) => {
        outgoing.set(n.id, []);
        inDegree.set(n.id, 0);
    });

    let hasValidEdges = false;
    connections.forEach((c) => {
        if (nodeIds.has(c.fromNodeId) && nodeIds.has(c.toNodeId) && c.fromNodeId !== c.toNodeId) {
            outgoing.get(c.fromNodeId)?.push(c.toNodeId);
            inDegree.set(c.toNodeId, (inDegree.get(c.toNodeId) || 0) + 1);
            hasValidEdges = true;
        }
    });

    if (hasValidEdges) {
        const queue: string[] = [];
        inDegree.forEach((deg, id) => {
            if (deg === 0) queue.push(id);
        });

        const topoSortedIds: string[] = [];
        while (queue.length > 0) {
            // 同批入度为 0 的节点，按空间自左向右优先出队
            queue.sort((aId, bId) => {
                const a = nodeMap.get(aId)!;
                const b = nodeMap.get(bId)!;
                return a.position.x - b.position.x;
            });
            const currId = queue.shift()!;
            topoSortedIds.push(currId);

            outgoing.get(currId)?.forEach((nextId) => {
                const newDeg = (inDegree.get(nextId) || 1) - 1;
                inDegree.set(nextId, newDeg);
                if (newDeg === 0) queue.push(nextId);
            });
        }

        // 若所有选中节点均在拓扑图流中，则直接采用拓扑流
        if (topoSortedIds.length === nodes.length) {
            return topoSortedIds.map((id) => nodeMap.get(id)!);
        }
    }

    // 2. 尝试从标题中提取分镜/镜头数字编号 (如 "分镜 01", "镜头 2", "Shot 3", "01-驶出车库")
    const titleRegex = /(?:分镜|镜头|镜|shot|scene|#)?\s*0*([1-9]\d*)/i;
    const titleNumbers = nodes.map((n) => {
        const match = (n.title || "").match(titleRegex);
        return match ? parseInt(match[1], 10) : null;
    });

    const allHaveTitleNumbers = titleNumbers.every((num) => num !== null);
    const uniqueTitleNumbers = new Set(titleNumbers.filter((n): n is number => n !== null));
    if (allHaveTitleNumbers && uniqueTitleNumbers.size === nodes.length) {
        return [...nodes].sort((a, b) => {
            const numA = parseInt((a.title || "").match(titleRegex)![1], 10);
            const numB = parseInt((b.title || "").match(titleRegex)![1], 10);
            return numA - numB;
        });
    }

    // 3. 标准多行故事板视觉阅读顺序（按行容差归类：自上而下，同每行自左向右）
    const avgHeight = nodes.reduce((sum, n) => sum + (n.height || 240), 0) / nodes.length;
    // 垂直距离超过半个分镜高度即视为新的一行故事板
    const rowTolerance = Math.max(120, avgHeight * 0.5);

    return [...nodes].sort((a, b) => {
        const yDiff = a.position.y - b.position.y;
        if (Math.abs(yDiff) > rowTolerance) {
            return yDiff; // 上方行优先
        }
        return a.position.x - b.position.x; // 同一行内从左到右
    });
}
