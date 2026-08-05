import { Container } from "@/components/layout/container";
import { Badge } from "@/components/ui/badge";
import { Editable } from "@/components/theme/cte/editable";
import type { BadgeListSection as BadgeListSectionData } from "@/lib/theme";

type BadgeListSectionProps = BadgeListSectionData & { sectionIndex: number };

export function BadgeListSection({ sectionIndex, heading, badges }: BadgeListSectionProps) {
  return (
    <section>
      <Container className="space-y-4 py-16">
        <h2 className="text-xl font-semibold">
          <Editable path={`${sectionIndex}.heading`} fieldType="text" value={heading}>
            {heading}
          </Editable>
        </h2>
        {/* Edited as one comma-separated list rather than per-badge — see
           cte-editor-popover.tsx's "badge-list" fieldType. */}
        <Editable as="div" path={`${sectionIndex}.badges`} fieldType="badge-list" value={badges} className="flex flex-wrap gap-2">
          {badges.map((badge) => (
            <Badge key={badge} variant="secondary">
              {badge}
            </Badge>
          ))}
        </Editable>
      </Container>
    </section>
  );
}
