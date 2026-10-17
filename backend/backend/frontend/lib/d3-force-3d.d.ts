declare module "d3-force-3d" {
  export interface CollisionForce<NodeType> {
    (alpha: number): void;
    initialize?: (nodes: NodeType[], ...args: any[]) => void;
    radius(radius: number | ((node: NodeType, index: number, nodes: NodeType[]) => number)): CollisionForce<NodeType>;
    strength(value: number): CollisionForce<NodeType>;
    iterations(value: number): CollisionForce<NodeType>;
    [key: string]: any;
  }

  export function forceCollide<NodeType>(
    radius?: number | ((node: NodeType, index: number, nodes: NodeType[]) => number),
  ): CollisionForce<NodeType>;
}
