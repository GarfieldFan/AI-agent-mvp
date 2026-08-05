import type { Metadata } from "next";

import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { ChatPanel } from "@/components/modules/chat/chat-panel";

export const metadata: Metadata = {
  title: "Chatbot",
  description: "RAG-grounded conversational assistant with structured lead capture.",
};

export default function ChatPage() {
  return (
    <Container className="space-y-8 py-12">
      <PageHeader
        title="Chatbot"
        description="Answers from uploaded company documents when relevant (with citations), and replaces a traditional contact form otherwise — captures intent and structured details through a mix of free text and generated form controls, then hands off to CRM/a human."
      />
      <ChatPanel />
    </Container>
  );
}
