"use client";

import { Swiper, SwiperSlide } from "swiper/react";
import { Autoplay, Pagination } from "swiper/modules";
import "swiper/css";
import "swiper/css/pagination";

import { Container } from "@/components/layout/container";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import type { CarouselSection as CarouselSectionData } from "@/lib/theme";

export function CarouselSection({ heading, slides }: CarouselSectionData) {
  if (slides.length === 0) return null;

  return (
    <section>
      <Container className="space-y-4 py-16">
        {heading ? <h2 className="text-xl font-semibold">{heading}</h2> : null}
        <Swiper
          modules={[Autoplay, Pagination]}
          autoplay={{ delay: 4000, disableOnInteraction: false }}
          pagination={{ clickable: true }}
          loop={slides.length > 1}
          className="overflow-hidden rounded-xl"
        >
          {slides.map((slide, index) => (
            // Slide URLs are frequently "#" (placeholder) for generated
            // content — index, not url, is the only guaranteed-unique key.
            <SwiperSlide key={index}>
              <div className="relative aspect-[16/7] w-full">
                <ThemeImageBox image={slide} />
              </div>
            </SwiperSlide>
          ))}
        </Swiper>
      </Container>
    </section>
  );
}
